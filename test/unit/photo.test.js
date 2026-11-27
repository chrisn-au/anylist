const assert = require('assert');
const protobuf = require('protobufjs');
const definitions = require('../../lib/definitions.json');
const Recipe = require('../../lib/recipe');
const {uploadPhoto, detectImageType, MAX_PHOTO_BYTES} = require('../../lib/photo');

const pb = protobuf.newBuilder({}).import(definitions).build('pcov.proto');
const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10]);
const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0]);

function fakeClient() {
	const calls = [];
	return {calls, async post(url, options) {
		calls.push({url, options});
		return {};
	}};
}

describe('photo upload (mocked client)', () => {
	it('detects JPEG and PNG and rejects anything else', () => {
		assert.deepStrictEqual(detectImageType(JPEG), {ext: 'jpg', mimeType: 'image/jpeg'});
		assert.deepStrictEqual(detectImageType(PNG), {ext: 'png', mimeType: 'image/png'});
		assert.strictEqual(detectImageType(Buffer.from('GIF89a')), null);
	});

	it('uploads bytes to data/photos/upload and returns a 32-hex id', async () => {
		const client = fakeClient();
		const id = await uploadPhoto(client, JPEG);
		assert.match(id, /^[0-9a-f]{32}$/);
		assert.strictEqual(client.calls.length, 1);
		assert.strictEqual(client.calls[0].url, 'data/photos/upload');
		assert.ok(client.calls[0].options.body, 'multipart body sent');
	});

	it('sends a URL to data/photos/upload-url', async () => {
		const client = fakeClient();
		const id = await uploadPhoto(client, 'https://example.com/dish.jpg');
		assert.match(id, /^[0-9a-f]{32}$/);
		assert.strictEqual(client.calls[0].url, 'data/photos/upload-url');
	});

	it('rejects non-https URLs, non-images and oversize bytes without a request', async () => {
		const client = fakeClient();
		await assert.rejects(uploadPhoto(client, 'http://example.com/a.jpg'), /https/);
		await assert.rejects(uploadPhoto(client, Buffer.from('not an image at all')), /JPEG or PNG/);
		const big = Buffer.concat([JPEG, Buffer.alloc(MAX_PHOTO_BYTES)]);
		await assert.rejects(uploadPhoto(client, big), /larger/);
		assert.strictEqual(client.calls.length, 0);
	});

	it('Recipe.setPhoto uploads and sets photoIds ready for save', async () => {
		const client = fakeClient();
		const recipe = new Recipe({name: 'Soup'}, {client, protobuf: pb, uid: 'u', recipeDataId: 'rd'});
		const id = await recipe.setPhoto(JPEG);
		assert.deepStrictEqual(recipe.photoIds, [id]);
		assert.strictEqual(recipe._encode().photoIds.length, 1);
	});
});
