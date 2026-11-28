const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const util = require('util');
const AnyList = require('../../lib');
const {uploadPhoto} = require('../../lib/photo');

function tmpFile() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anylist-sec-'));
	return path.join(dir, 'creds');
}

function legacyEncrypt(credentials, secret) {
	const key = crypto.createHash('sha256').update(String(secret)).digest('base64').slice(0, 32);
	const iv = crypto.randomBytes(16);
	const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key), iv);
	const enc = Buffer.concat([cipher.update(JSON.stringify(credentials)), cipher.final()]);
	return JSON.stringify({iv: iv.toString('hex'), cipher: enc.toString('hex')});
}

describe('security hardening', function () {
	this.timeout(10_000);

	it('stores credentials owner-only, as scrypt + AES-256-GCM, and reads them back', async () => {
		const file = tmpFile();
		const a = new AnyList({email: 'e', password: 'correct horse', credentialsFile: file});
		a.clientId = 'c1';
		a.accessToken = 'at';
		a.refreshToken = 'rt';
		await a._storeCredentials();
		// eslint-disable-next-line no-bitwise
		assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
		const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
		assert.strictEqual(stored.v, 2);
		assert.strictEqual(stored.kdf, 'scrypt');
		assert.ok(stored.salt && stored.tag);
		assert.ok(!fs.readFileSync(file, 'utf8').includes('rt'), 'no plaintext token');

		const b = new AnyList({email: 'e', password: 'correct horse', credentialsFile: file});
		await b._loadCredentials();
		assert.deepStrictEqual([b.clientId, b.accessToken, b.refreshToken], ['c1', 'at', 'rt']);
	});

	it('a wrong password or tampered file does not load', async () => {
		const file = tmpFile();
		const a = new AnyList({email: 'e', password: 'pw-one', credentialsFile: file});
		a.clientId = 'c1';
		a.accessToken = 'at';
		a.refreshToken = 'rt';
		await a._storeCredentials();
		const wrong = new AnyList({email: 'e', password: 'pw-two', credentialsFile: file});
		await wrong._loadCredentials();
		assert.strictEqual(wrong.accessToken, undefined);

		const data = JSON.parse(fs.readFileSync(file, 'utf8'));
		data.cipher = (data.cipher[0] === 'a' ? 'b' : 'a') + data.cipher.slice(1);
		fs.writeFileSync(file, JSON.stringify(data));
		const tampered = new AnyList({email: 'e', password: 'pw-one', credentialsFile: file});
		await tampered._loadCredentials();
		assert.strictEqual(tampered.accessToken, undefined, 'GCM rejects tampering');
	});

	it('upgrades an old-format, world-readable file on load', async () => {
		const file = tmpFile();
		fs.writeFileSync(file, legacyEncrypt({clientId: 'c1', accessToken: 'at', refreshToken: 'rt'}, 'pw'), {mode: 0o644});
		const a = new AnyList({email: 'e', password: 'pw', credentialsFile: file});
		await a._loadCredentials();
		assert.strictEqual(a.refreshToken, 'rt');
		assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).v, 2);
		// eslint-disable-next-line no-bitwise
		assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
	});

	it('refuses absurd scrypt parameters in a crafted file', async () => {
		const file = tmpFile();
		fs.writeFileSync(file, JSON.stringify({v: 2, N: 2 ** 30, r: 8, p: 1, salt: '00', iv: '00', tag: '00', cipher: '00'}));
		const a = new AnyList({email: 'e', password: 'pw', credentialsFile: file});
		await a._loadCredentials();
		assert.strictEqual(a.accessToken, undefined);
	});

	it('never writes tokens to disk without a password', async () => {
		const file = tmpFile();
		const a = new AnyList({email: 'e', credentialsFile: file});
		a.accessToken = 'at';
		await a._storeCredentials();
		assert.ok(!fs.existsSync(file));
	});

	it('the password and tokens do not show in console.log or JSON.stringify', () => {
		const a = new AnyList({email: 'me@example.com', password: 'hunter2-secret', credentialsFile: null});
		a.accessToken = 'access-secret';
		a.refreshToken = 'refresh-secret';
		const shown = util.inspect(a, {depth: 1}) + JSON.stringify(Object.fromEntries(Object.entries(a).filter(([k]) => !k.startsWith('_') && k !== 'protobuf' && k !== 'client' && k !== 'authClient')));
		for (const secret of ['hunter2-secret', 'access-secret', 'refresh-secret']) {
			assert.ok(!shown.includes(secret), `${secret} leaked`);
		}

		assert.strictEqual(a.password, 'hunter2-secret', 'still usable');
	});

	it('concurrent token refreshes share one request', async () => {
		const a = new AnyList({email: 'e', password: 'pw', credentialsFile: null});
		let calls = 0;
		a._doRefreshTokens = async () => {
			calls += 1;
			await new Promise(resolve => {
				setTimeout(resolve, 20);
			});
		};

		await Promise.all([a._refreshTokens(), a._refreshTokens(), a._refreshTokens()]);
		assert.strictEqual(calls, 1);
		await a._refreshTokens();
		assert.strictEqual(calls, 2, 'a later refresh runs again');
	});

	it('photo URLs must be plain https without embedded credentials', async () => {
		const client = {async post() {
			return {};
		}};
		await assert.rejects(uploadPhoto(client, 'https://user:pw@example.com/a.jpg'), /username or password/);
		await assert.rejects(uploadPhoto(client, 'http://example.com/a.jpg'), /https/);
		await assert.rejects(uploadPhoto(client, 'https://'), /valid https URL/);
	});
});
