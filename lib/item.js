const FormData = require('form-data');
const uuid = require('./uuid');
const {checkProcessed} = require('./processed');

const OP_MAPPING = {
	name: 'set-list-item-name',
	quantity: 'set-list-item-quantity',
	details: 'set-list-item-details',
	checked: 'set-list-item-checked',
	categoryMatchId: 'set-list-item-category-match-id',
	manualSortIndex: 'set-list-item-sort-order',
};

/**
 * Item class.
 * @class
 *
 * @param {object} item item
 * @param {object} context context
 *
 * @property {string} listId
 * @property {string} identifier
 * @property {string} name
 * @property {string} details
 * @property {string} quantity
 * @property {string} checked
 * @property {string} manualSortIndex
 * @property {string} userId
 * @property {string} categoryMatchId
 * @property {string} recipeId
 * @property {string} rawIngredient
 * @property {Array<{recipeId: string, recipeName: string, eventId: string, eventDate: string}>} ingredients
 */
class Item {
	/**
   * @hideconstructor
   */
	constructor(i, {client, protobuf, uid}) {
		// The item exactly as AnyList sent it (null for new items), so whole-item
		// operations such as a category change never drop fields this class does not model.
		this._raw = i && typeof i.toBuffer === 'function' ? i : null;
		this._listId = i.listId;
		this._identifier = i.identifier || uuid();
		this._name = i.name;
		this._details = i.details;
		// Read quantity from quantityPb.amount, deprecatedQuantity, or fall back to quantity
		this._quantity = i.quantityPb?.amount ?? i.deprecatedQuantity ?? i.quantity;
		this._checked = i.checked;
		this._manualSortIndex = i.manualSortIndex;
		this._userId = i.userId;
		this._categoryMatchId = i.categoryMatchId;
		this._category = i.category;
		this._recipeId = i.recipeId || null;
		this._rawIngredient = i.rawIngredient || null;
		this._ingredients = (i.ingredients || []).map(ing => ({
			recipeId: ing.recipeId || null,
			recipeName: ing.recipeName || null,
			eventId: ing.eventId || null,
			eventDate: ing.eventDate || null,
		}));

		this._client = client;
		this._protobuf = protobuf;
		this._uid = uid;

		this._fieldsToUpdate = [];
	}

	toJSON() {
		return {
			listId: this._listId,
			identifier: this._identifier,
			name: this._name,
			details: this._details,
			quantity: this._quantity,
			checked: this._checked,
			manualSortIndex: this._manualSortIndex,
			userId: this._userId,
			categoryMatchId: this._categoryMatchId,
			recipeId: this._recipeId,
			rawIngredient: this._rawIngredient,
			ingredients: this._ingredients,
		};
	}

	_encode() {
		const item = {
			identifier: this._identifier,
			listId: this._listId,
			name: this._name,
			details: this._details,
			checked: this._checked,
			category: this._category,
			userId: this._userId,
			categoryMatchId: this._categoryMatchId,
			manualSortIndex: this._manualSortIndex,
			recipeId: this._recipeId,
			rawIngredient: this._rawIngredient,
			ingredients: this._ingredients,
		};

		// Encode quantity as quantityPb.amount per protobuf schema (must be string)
		if (this._quantity) {
			item.quantityPb = {amount: String(this._quantity)};
		}

		return new this._protobuf.ListItem(item);
	}

	get identifier() {
		return this._identifier;
	}

	set identifier(_) {
		throw new Error('You cannot update an item ID.');
	}

	get listId() {
		return this._listId;
	}

	set listId(l) {
		if (this._listId === undefined) {
			this._listId = l;
			// Not an item field AnyList can update: setting it is local only (List.addItem does it).
		} else {
			throw new Error('You cannot move items between lists.');
		}
	}

	get name() {
		return this._name;
	}

	set name(n) {
		this._name = n;
		this._fieldsToUpdate.push('name');
	}

	get quantity() {
		return this._quantity;
	}

	set quantity(q) {
		if (typeof q === 'number') {
			q = q.toString();
		}

		this._quantity = q;
		this._fieldsToUpdate.push('quantity');
	}

	get details() {
		return this._details;
	}

	set details(d) {
		this._details = d;
		this._fieldsToUpdate.push('details');
	}

	get checked() {
		return this._checked;
	}

	set checked(c) {
		if (typeof c !== 'boolean') {
			throw new TypeError('Checked must be a boolean.');
		}

		this._checked = c;
		this._fieldsToUpdate.push('checked');
	}

	get userId() {
		return this._userId;
	}

	set userId(_) {
		throw new Error('Cannot set user ID of an item after creation.');
	}

	/** Category name stored on the item itself (may be stale; prefer the list's categories by matchId). */
	get category() {
		return this._category;
	}

	get categoryMatchId() {
		return this._categoryMatchId;
	}

	set categoryMatchId(i) {
		this._categoryMatchId = i;
		this._fieldsToUpdate.push('categoryMatchId');
	}

	get recipeId() {
		return this._recipeId;
	}

	set recipeId(_) {
		throw new Error('Recipe ID is read-only.');
	}

	get rawIngredient() {
		return this._rawIngredient;
	}

	set rawIngredient(_) {
		throw new Error('Raw ingredient is read-only.');
	}

	get ingredients() {
		return this._ingredients;
	}

	set ingredients(_) {
		throw new Error('Ingredients is read-only.');
	}

	get manualSortIndex() {
		return this._manualSortIndex;
	}

	set manualSortIndex(i) {
		if (typeof i !== 'number') {
			throw new TypeError('Sort index must be a number.');
		}

		this._manualSortIndex = i;
		this._fieldsToUpdate.push('manualSortIndex');
	}

	/**
	 * Move this item to another category on its list, the way AnyList's web app
	 * does: two operations carrying the complete item, before and after, with the
	 * new category match id in originalValue. AnyList can acknowledge without
	 * applying it, so read the list back to confirm.
	 * @param {{matchId: string, name?: string}} category target category
	 * @return {Promise}
	 */
	async setCategory({matchId, name} = {}) {
		if (!matchId) {
			throw new Error('Category match id is required.');
		}

		if (!this._listId) {
			throw new Error('Item has no list.');
		}

		const {ListItem} = this._protobuf;
		const original = this._raw ? ListItem.decode(this._raw.toBuffer()) : this._encode();
		const updated = ListItem.decode(original.toBuffer());
		updated.listId = this._listId;
		updated.categoryMatchId = matchId;
		if (name) {
			updated.category = name;
		}

		const op = (handlerId, listItem, extra = {}) => {
			const operation = new this._protobuf.PBListOperation();
			operation.setMetadata({operationId: uuid(), handlerId, userId: this._uid});
			operation.setListId(this._listId);
			operation.setListItemId(this._identifier);
			operation.setListItem(listItem);
			if (extra.originalValue) {
				operation.setOriginalValue(extra.originalValue);
			}

			return operation;
		};

		const ops = new this._protobuf.PBListOperationList();
		ops.setOperations([
			op('update-list-item-category-assignment', original),
			op('set-list-item-category-match-id', updated, {originalValue: matchId}),
		]);
		const form = new FormData();
		form.append('operations', ops.toBuffer());
		const response = await this._client.post('data/shopping-lists/update', {body: form});
		const result = checkProcessed(this._protobuf, response, ops);

		this._categoryMatchId = matchId;
		if (name) {
			this._category = name;
		}

		this._raw = updated;
		return result;
	}

	/**
   * Save local changes to item to
   * AnyList's API.	/**
   * Save local changes to item to
   * AnyList's API.
   * Must set `isFavorite=true` if editing "favorites" list
   * @param {boolean} [isFavorite=false]
   * @return {Promise}
   */
	async save(isFavorite = false) {
		// Each changed field once, then forget it: a later save must not resend earlier changes.
		const fields = [...new Set(this._fieldsToUpdate)].filter(field => OP_MAPPING[field]);
		this._fieldsToUpdate = [];
		if (fields.length === 0) {
			return {verified: true};
		}

		const ops = fields.map(field => {
			const value = this[field];
			const opName = OP_MAPPING[field];

			const op = new this._protobuf.PBListOperation();

			op.setMetadata({
				operationId: uuid(),
				handlerId: opName,
				userId: this._uid,
			});

			op.setListId(this._listId);
			op.setListItemId(this._identifier);

			if (typeof value === 'boolean') {
				op.setUpdatedValue(value === true ? 'y' : 'n');
			} else {
				op.setUpdatedValue(value.toString());
			}

			return op;
		});

		const opList = new this._protobuf.PBListOperationList();

		opList.setOperations(ops);

		const form = new FormData();

		form.append('operations', opList.toBuffer());

		const response = await this._client.post(isFavorite ? 'data/starter-lists/update' : 'data/shopping-lists/update', {
			body: form,
		});
		return checkProcessed(this._protobuf, response, opList);
	}
}

module.exports = Item;
