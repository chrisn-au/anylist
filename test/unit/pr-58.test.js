const assert = require('assert');
const protobuf = require('protobufjs');
const definitions = require('../../lib/definitions.json');
const Recipe = require('../../lib/recipe');
const Ingredient = require('../../lib/ingredient');

const pb = protobuf.newBuilder({}).import(definitions).build('pcov.proto');
const ctx = {client: {}, protobuf: pb, uid: 'user-1', recipeDataId: 'rd-1'};

describe('Recipe encoding (PR #58)', () => {
	it('omits timestamp and recipeDataId when encoding for a save', () => {
		const r = new Recipe({identifier: 'r1', name: 'Soup', timestamp: 123, ingredients: [{name: 'Pumpkin', quantity: '1 kg'}]}, ctx);
		const encoded = r._encode(false);
		assert.strictEqual(encoded.name, 'Soup');
		assert.ok(!encoded.timestamp);
		assert.ok(!encoded.recipeDataId);
		assert.strictEqual(encoded.ingredients[0].name, 'Pumpkin');
	});

	it('includes timestamp and recipeDataId for a remove', () => {
		const r = new Recipe({identifier: 'r1', name: 'Soup', timestamp: 123}, ctx);
		const encoded = r._encode(true);
		assert.strictEqual(encoded.timestamp, 123);
		assert.strictEqual(encoded.recipeDataId, 'rd-1');
	});

	it('ingredients keep their identifier and heading flag', () => {
		const i = new Ingredient({identifier: 'ing-1', name: 'Salt', isHeading: false}, ctx);
		assert.strictEqual(i.toJSON().identifier, 'ing-1');
		assert.strictEqual(i.toJSON().isHeading, false);
		assert.strictEqual(i._encode().identifier, 'ing-1');
	});
});
