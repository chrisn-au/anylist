const EventEmitter = require('events');
const crypto = require('crypto');
const process = require('process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {Buffer} = require('buffer');
const got = require('got');
const WebSocket = require('reconnecting-websocket');
const WS = require('ws');
const protobuf = require('protobufjs');
const FormData = require('form-data');
const definitions = require('./definitions.json');
const List = require('./list');
const Item = require('./item');
const uuid = require('./uuid');
const Recipe = require('./recipe');
const RecipeCollection = require('./recipe-collection');
const MealPlanningCalendarEvent = require('./meal-planning-calendar-event');
const MealPlanningCalendarEventLabel = require('./meal-planning-calendar-label');

const CREDENTIALS_KEY_CLIENT_ID = 'clientId';
const CREDENTIALS_KEY_ACCESS_TOKEN = 'accessToken';
const CREDENTIALS_KEY_REFRESH_TOKEN = 'refreshToken';

function decodeJwtSubject(token) {
	if (!token || typeof token !== 'string') {
		return null;
	}

	const parts = token.split('.');
	if (parts.length < 2) {
		return null;
	}

	try {
		const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
		return typeof payload.sub === 'string' ? payload.sub : null;
	} catch {
		return null;
	}
}

/**
 * AnyList class. There should be one
 * instance per account.
 * @class
 * @param {object} options account options
 * @param {string} options.email email
 * @param {string} options.password password
 * @param {string} options.credentialsFile file path for credentials storage file
 *
 * @property {List[]} lists
 * @property {Object.<string, Item[]>} recentItems
 * @property {List[]} favoriteItems
 * @property {Recipe[]} recipes
 * @fires AnyList#lists-update
 */

const REQUEST_TIMEOUT_MS = 30_000;

// Stored-credentials format 2: scrypt key derivation with a random salt, then
// AES-256-GCM. Format 1 (sha256(password) + AES-256-CBC) is still read and is
// upgraded on the next write.
const CREDENTIALS_FORMAT = 2;
const SCRYPT_PARAMS = {N: 2 ** 15, r: 8, p: 1};
const SCRYPT_MAX_N = 2 ** 20;

function scryptKey(secret, salt, {N, r, p}) {
	return new Promise((resolve, reject) => {
		crypto.scrypt(String(secret), salt, 32, {N, r, p, maxmem: 256 * 1024 * 1024}, (error, key) => {
			if (error) {
				reject(error);
			} else {
				resolve(key);
			}
		});
	});
}

/** Auth endpoints carry the password or tokens in the request; keep them out of thrown errors. */
function sanitizeAuthError(error) {
	const safe = new Error(error.message);
	safe.name = error.name;
	safe.code = error.code;
	if (error.response) {
		safe.response = {statusCode: error.response.statusCode};
	}

	return safe;
}

/** Got handler: turn a form-data body into a Buffer plus its multipart headers. */
function formDataAsBuffer(options, next) {
	if (options.body instanceof FormData) {
		const form = options.body;
		options.headers = {...options.headers, ...form.getHeaders()};
		options.body = form.getBuffer();
	}

	return next(options);
}

class AnyList extends EventEmitter {
	constructor({email, password, credentialsFile = path.join(os.homedir(), '.anylist_credentials'), refreshOnPush = true}) {
		super();

		this.email = email;
		// Secrets are non-enumerable so console.log / JSON.stringify of the client never print them.
		for (const key of ['password', 'accessToken', 'refreshToken']) {
			Object.defineProperty(this, key, {value: undefined, writable: true, enumerable: false, configurable: true});
		}

		this.password = password;
		this.credentialsFile = credentialsFile;
		this.refreshOnPush = refreshOnPush;

		this.authClient = got.extend({
			// A hung AnyList request must fail, not wait forever.
			timeout: REQUEST_TIMEOUT_MS,
			// Form-data bodies are one-shot streams: the 401 retry below would re-send an
			// already-drained stream and hang. Send them as buffers so a retry can resend.
			handlers: [formDataAsBuffer],
			headers: {
				'X-AnyLeaf-API-Version': '3',
			},
			prefixUrl: 'https://www.anylist.com',
			followRedirect: false,
			hooks: {
				beforeError: [
					error => {
						const {response} = error;
						if (response && response.request) {
							const url = response.request.options.url.href;
							console.error(`Endpoint ${url} returned uncaught status code ${response.statusCode}`);
						}

						const path = error.options && error.options.url ? error.options.url.pathname : '';
						return path.startsWith('/auth/') ? sanitizeAuthError(error) : error;
					},
				],
			},
		});

		this.client = this.authClient.extend({
			mutableDefaults: true,
			hooks: {
				beforeRequest: [
					options => {
						options.headers = {
							'X-AnyLeaf-Client-Identifier': this.clientId,
							authorization: `Bearer ${this.accessToken}`,
							...options.headers,
						};

						const path = options.url.pathname;
						if (path.startsWith('/data/')) {
							options.responseType = 'buffer';
						}
					},
				],
				afterResponse: [
					async (response, retryWithMergedOptions) => {
						if (response.statusCode !== 401) {
							return response;
						}

						const url = response.request.options.url.href;
						console.info(`Endpoint ${url} returned status code 401, refreshing access token before retrying`);

						await this._refreshTokens();
						return retryWithMergedOptions({
							headers: {
								authorization: `Bearer ${this.accessToken}`,
							},
						});
					},
				],
				beforeError: [
					error => {
						const {response} = error;
						if (response && response.request) {
							const url = response.request.options.url.href;
							console.error(`Endpoint ${url} returned uncaught status code ${response.statusCode}`);
						}

						return error;
					},
				],
			},
		});

		this.protobuf = protobuf.newBuilder({}).import(definitions).build('pcov.proto');

		this.lists = [];
		this.favoriteItems = [];
		this.recentItems = {};
		this.recipes = [];
		this.recipeDataId = null;
		this._userData = null;
		this.calendarId = null;
	}

	/**
   * Log into the AnyList account provided
   * in the constructor.
   */
	async login(connectWebSocket = true) {
		await this._loadCredentials();
		this.clientId = await this._getClientId();

		if (!this.accessToken || !this.refreshToken) {
			console.info('No saved tokens found, fetching new tokens using credentials');
			await this._fetchTokens();
		}

		this.uid = decodeJwtSubject(this.accessToken);

		if (connectWebSocket) {
			this._setupWebSocket();
		}
	}

	async _fetchTokens() {
		const form = new FormData();
		form.append('email', this.email);
		form.append('password', this.password);

		const result = await this.authClient.post('auth/token', {
			body: form,
		}).json();

		this.accessToken = result.access_token;
		this.refreshToken = result.refresh_token;
		await this._storeCredentials();
	}

	/**
	 * Refresh the access token. Concurrent callers share one refresh: AnyList
	 * rotates the refresh token, so parallel refreshes would invalidate each
	 * other and fall back to sending the password again.
	 */
	async _refreshTokens() {
		if (!this._refreshInFlight) {
			this._refreshInFlight = this._doRefreshTokens().finally(() => {
				this._refreshInFlight = null;
			});
		}

		return this._refreshInFlight;
	}

	async _doRefreshTokens() {
		const form = new FormData();
		form.append('refresh_token', this.refreshToken);

		try {
			const result = await this.authClient.post('auth/token/refresh', {
				body: form,
			}).json();

			this.accessToken = result.access_token;
			this.refreshToken = result.refresh_token;
			this.uid = decodeJwtSubject(this.accessToken);
			await this._storeCredentials();
		} catch (error) {
			if (!error.response || error.response.statusCode !== 401) {
				throw error;
			}

			console.info('Failed to refresh access token, fetching new tokens using credentials');
			await this._fetchTokens();
		}
	}

	async _getClientId() {
		if (this.clientId) {
			return this.clientId;
		}

		console.info('No saved clientId found, generating new clientId');

		const clientId = uuid();
		this.clientId = clientId;
		await this._storeCredentials();
		return clientId;
	}

	async _loadCredentials() {
		if (!this.credentialsFile) {
			return;
		}

		if (!fs.existsSync(this.credentialsFile)) {
			console.info('Credentials file does not exist, not loading saved credentials');
			return;
		}

		try {
			const encrypted = await fs.promises.readFile(this.credentialsFile);
			const {credentials, legacy} = await this._decryptCredentials(encrypted, this.password);
			this.clientId = credentials[CREDENTIALS_KEY_CLIENT_ID];
			this.accessToken = credentials[CREDENTIALS_KEY_ACCESS_TOKEN];
			this.refreshToken = credentials[CREDENTIALS_KEY_REFRESH_TOKEN];
			const {mode} = await fs.promises.stat(this.credentialsFile);
			// eslint-disable-next-line no-bitwise
			if (legacy || (mode & 0o077) !== 0) {
				console.info('Upgrading stored credentials file to the current format and permissions');
				await this._storeCredentials();
			}
		} catch (error) {
			console.error(`Failed to read stored credentials: ${error.message}`);
		}
	}

	async _storeCredentials() {
		if (!this.credentialsFile) {
			return;
		}

		if (!this.password) {
			// Without a password there is no key worth having; do not write tokens to disk.
			return;
		}

		const credentials = {
			[CREDENTIALS_KEY_CLIENT_ID]: this.clientId,
			[CREDENTIALS_KEY_ACCESS_TOKEN]: this.accessToken,
			[CREDENTIALS_KEY_REFRESH_TOKEN]: this.refreshToken,
		};
		const temporary = `${this.credentialsFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
		try {
			const encrypted = await this._encryptCredentials(credentials, this.password);
			// Owner-only, written to a temp file then renamed so readers never see a half-written file.
			await fs.promises.writeFile(temporary, encrypted, {mode: 0o600});
			await fs.promises.rename(temporary, this.credentialsFile);
			await fs.promises.chmod(this.credentialsFile, 0o600);
		} catch (error) {
			await fs.promises.rm(temporary, {force: true}).catch(() => {});
			console.error(`Failed to write credentials to storage: ${error.message}`);
		}
	}

	async _encryptCredentials(credentials, secret) {
		const salt = crypto.randomBytes(16);
		const key = await scryptKey(secret, salt, SCRYPT_PARAMS);
		const iv = crypto.randomBytes(12);
		const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
		const encrypted = Buffer.concat([cipher.update(JSON.stringify(credentials)), cipher.final()]);
		return JSON.stringify({
			v: CREDENTIALS_FORMAT,
			kdf: 'scrypt',
			N: SCRYPT_PARAMS.N,
			r: SCRYPT_PARAMS.r,
			p: SCRYPT_PARAMS.p,
			salt: salt.toString('hex'),
			iv: iv.toString('hex'),
			tag: cipher.getAuthTag().toString('hex'),
			cipher: encrypted.toString('hex'),
		});
	}

	async _decryptCredentials(data, secret) {
		const encrypted = JSON.parse(data);
		if (encrypted.v === CREDENTIALS_FORMAT) {
			const N = Number(encrypted.N);
			const r = Number(encrypted.r);
			const p = Number(encrypted.p);
			if (!(N > 1 && N <= SCRYPT_MAX_N && r >= 1 && r <= 32 && p >= 1 && p <= 16)) {
				throw new Error('Stored credentials have unsupported key parameters.');
			}

			const key = await scryptKey(secret, Buffer.from(encrypted.salt, 'hex'), {N, r, p});
			const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.iv, 'hex'));
			decipher.setAuthTag(Buffer.from(encrypted.tag, 'hex'));
			const plain = Buffer.concat([decipher.update(Buffer.from(encrypted.cipher, 'hex')), decipher.final()]);
			return {credentials: JSON.parse(plain.toString()), legacy: false};
		}

		// Format 1, written by earlier versions.
		const key = crypto.createHash('sha256').update(String(secret)).digest('base64').slice(0, 32);
		const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key), Buffer.from(encrypted.iv, 'hex'));
		let plain = decipher.update(Buffer.from(encrypted.cipher, 'hex'));
		plain = Buffer.concat([plain, decipher.final()]);
		return {credentials: JSON.parse(plain.toString()), legacy: true};
	}

	_setupWebSocket() {
		// One socket class per client, so two accounts in one process never share a token.
		const credentials = () => ({token: this.accessToken, clientId: this.clientId});
		class AuthenticatedWebSocket extends WS {
			constructor(url, protocols) {
				const {token, clientId} = credentials();
				super(url, protocols, {
					headers: {
						authorization: `Bearer ${token}`,
						'x-anyleaf-client-identifier': clientId,
						'X-AnyLeaf-API-Version': '3',
					},
				});
			}
		}

		this.ws = new WebSocket('wss://www.anylist.com/data/add-user-listener', [], {
			WebSocket: AuthenticatedWebSocket,
			maxReconnectAttempts: 2,
		});

		this.ws.addEventListener('open', () => {
			console.info('Connected to websocket');
			clearInterval(this._heartbeatPing);
			this._heartbeatPing = setInterval(() => {
				this.ws.send('--heartbeat--');
			}, 5000); // Web app heartbeats every 5 seconds
		});

		this.ws.addEventListener('close', () => {
			clearInterval(this._heartbeatPing);
		});

		// Listener errors must never become unhandled rejections: on Node 15+ they would exit the host process.
		this.ws.addEventListener('message', async ({data}) => {
			if (data !== 'refresh-shopping-lists') {
				return;
			}

			try {
				if (this.refreshOnPush === false) {
					/**
					 * Remote change event (refreshOnPush: false): lists changed elsewhere,
					 * nothing re-fetched. Lets callers batch fetches to stay under AnyList's
					 * sync rate limit.
					 * @event AnyList#remote-change
					 */
					this.emit('remote-change');
					return;
				}

				console.info('Refreshing shopping lists');

				/**
				 * Lists update event
				 * (fired when any list is modified by an outside actor).
				 * The instance's `.lists` are updated before the event fires.
				 *
				 * @event AnyList#lists-update
				 * @type {List[]} updated lists
				 */
				this.emit('lists-update', await this.getLists());
			} catch (error) {
				console.error(`Failed to refresh lists after a push: ${error.message}`);
			}
		});

		this.ws.addEventListener('error', async error => {
			console.error(`Disconnected from websocket: ${error.message}`);
			try {
				await this._refreshTokens();
			} catch (refreshError) {
				console.error(`Token refresh after websocket error failed: ${refreshError.message}`);
			}
		});
	}

	/**
   * Call when you're ready for your program
   * to exit.
   */
	teardown() {
		clearInterval(this._heartbeatPing);
		this._heartbeatPing = null;
		if (this.ws !== undefined) {
			this.ws.close();
		}
	}

	/**
	 * Create a new, empty shopping list (AnyList's new-shopping-list operation).
	 * AnyList can acknowledge without storing it, so callers should read the
	 * lists back before reporting success.
	 * @param {string} name list name
	 * @return {Promise<string>} the new list's identifier
	 */
	async createList(name) {
		const listName = String(name ?? '').trim();
		if (!listName) {
			throw new Error('List name must not be empty.');
		}

		const identifier = uuid();
		const list = new this.protobuf.ShoppingList({
			identifier,
			timestamp: Date.now() / 1000,
			name: listName,
			creator: this.uid,
			logicalClockTime: 1,
			allowsMultipleListCategoryGroups: true,
			listItemSortOrder: 0,
			newListItemPosition: 0,
		});
		const op = new this.protobuf.PBListOperation();
		op.setMetadata({operationId: uuid(), handlerId: 'new-shopping-list', userId: this.uid});
		op.setListId(identifier);
		op.setList(list);
		const ops = new this.protobuf.PBListOperationList();
		ops.setOperations([op]);
		const form = new FormData();
		form.append('operations', ops.toBuffer());
		await this.client.post('data/shopping-lists/update', {body: form});
		return identifier;
	}

	/**
   * Load all lists from account into memory.
   * @return {Promise<List[]>} lists
   */
	async getLists(refreshCache = true) {
		const decoded = await this._getUserData(refreshCache);

		this.lists = decoded.shoppingListsResponse.newLists.map(list => new List(list, this));

		for (const response of decoded.starterListsResponse.recentItemListsResponse.listResponses) {
			const list = response.starterList;
			this.recentItems[list.listId] = list.items.map(item => new Item(item, this));
		}

		const favoriteLists = decoded.starterListsResponse.favoriteItemListsResponse.listResponses.map(
			object => object.starterList,
		);

		this.favoriteItems = favoriteLists.map(
			list => new List(list, this),
		);

		return this.lists;
	}

	/**
   * Get List instance by ID.
   * @param {string} identifier list ID
   * @return {List} list
   */
	getListById(identifier) {
		return this.lists.find(l => l.identifier === identifier);
	}

	/**
   * Get List instance by name.
   * @param {string} name list name
   * @return {List} list
   */
	getListByName(name) {
		return this.lists.find(l => l.name === name);
	}

	/**
	* Get favorite items for a list.
	* @param {string} identifier list identifier
	* @return {List} favorites items array
	*/
	getFavoriteItemsByListId(identifier) {
		return this.favoriteItems.find(l => l.parentId === identifier);
	}

	/**
   * Load all meal planning calendar events from account into memory.
   * @return {Promise<MealPlanningCalendarEvent[]>} events
   */
	async getMealPlanningCalendarEvents(refreshCache = true) {
		const decoded = await this._getUserData(refreshCache);

		this.mealPlanningCalendarEvents = decoded.mealPlanningCalendarResponse.events.map(event => new MealPlanningCalendarEvent(event, this));

		// Map and assign labels
		this.mealPlanningCalendarEventLabels = decoded.mealPlanningCalendarResponse.labels.map(label => new MealPlanningCalendarEventLabel(label));
		for (const event of this.mealPlanningCalendarEvents) {
			event.label = this.mealPlanningCalendarEventLabels.find(label => label.identifier === event.labelId);
		}

		// Map and assign recipies
		this.recipes = decoded.recipeDataResponse.recipes.map(recipe => new Recipe(recipe, this));
		for (const event of this.mealPlanningCalendarEvents) {
			event.recipe = this.recipes.find(recipe => recipe.identifier === event.recipeId);
		}

		return this.mealPlanningCalendarEvents;
	}

	/**
   * Get the recently added items for a list
   * @param {string} listId list ID
   * @return {Item[]} recently added items array
   */
	getRecentItemsByListId(listId) {
		return this.recentItems[listId];
	}

	/**
   * Factory function to create new Items.
   * @param {object} item new item options
   * @return {Item} item
   */
	createItem(item) {
		return new Item(item, this);
	}

	/**
	 * Factory function to create a new MealPlanningCalendarEvent.
	 * @param {object} event new calendar event options.
	 * @return {MealPlanningCalendarEvent} event
	 */
	async createEvent(eventObject) {
		if (!this.calendarId) {
			await this._getUserData();
		}

		return new MealPlanningCalendarEvent(eventObject, this);
	}

	/**
   * Load all recipes from account into memory.
   * @return {Promise<Recipe[]>} recipes
	*/
	async getRecipes(refreshCache = true) {
		const decoded = await this._getUserData(refreshCache);

		this.recipes = decoded.recipeDataResponse.recipes.map(recipe => new Recipe(recipe, this));
		this.recipeDataId = decoded.recipeDataResponse.recipeDataId;
		return this.recipes;
	}

	/**
   * Factory function to create new Recipes.
   * @param {object} recipe new recipe options
   * @return {Recipe} recipe
   */
	async createRecipe(recipe) {
		if (!this.recipeDataId) {
			await this.getRecipes();
		}

		return new Recipe(recipe, this);
	}

	/**
	 * Load the user's recipe collections (AnyList's "tags" for recipes).
	 * @param {boolean} [refreshCache=true]
	 * @return {Promise<RecipeCollection[]>} collections
	 */
	async getRecipeCollections(refreshCache = true) {
		const decoded = await this._getUserData(refreshCache);
		this.recipeDataId = decoded.recipeDataResponse.recipeDataId;
		this.recipeCollections = (decoded.recipeDataResponse.recipeCollections ?? [])
			.map(collection => new RecipeCollection(collection, this));
		return this.recipeCollections;
	}

	/**
   * Factory function to create new Recipe Collections.
   * @param {object} recipeCollection new recipe options
   * @return {RecipeCollection} recipe collection
   */
	createRecipeCollection(recipeCollection) {
		return new RecipeCollection(recipeCollection, this);
	}

	async _getUserData(refreshCache) {
		if (!this._userData || refreshCache) {
			const result = await this.client.post('data/user-data/get');
			this._userData = this.protobuf.PBUserDataResponse.decode(result.body);
			this.calendarId = this._userData.mealPlanningCalendarResponse.calendarId;
		}

		return this._userData;
	}
}

module.exports = AnyList;
