const assert = require('assert');
const protobuf = require('protobufjs');
const definitions = require('../../lib/definitions.json');
const Recipe = require('../../lib/recipe');
const MealPlanningCalendarEvent = require('../../lib/meal-planning-calendar-event');
const {uploadPhoto} = require('../../lib/photo');

const pb = protobuf.newBuilder({}).import(definitions).build('pcov.proto');
const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0]);

function capture() {
	const calls = [];
	return {calls, async post(url, options) {
		calls.push({url, body: options.body.getBuffer()});
		return {};
	}};
}

function decodeOps(type, call) {
	// Pull the protobuf bytes out of the multipart "operations" part.
	const raw = call.body;
	const start = raw.indexOf('\r\n\r\n') + 4;
	const end = raw.lastIndexOf('\r\n--');
	return pb[type].decode(raw.subarray(start, end));
}

describe('AnyList operation contract', () => {
	it('names every photo upload <id>.jpg, even PNG bytes', async () => {
		const client = capture();
		const id = await uploadPhoto(client, PNG);
		const text = client.calls[0].body.toString('latin1');
		assert.ok(text.includes(`filename="${id}.jpg"`));
		assert.ok(!text.includes('.png'));
	});

	it('saves an existing meal plan event with update-event, a new one with new-event', async () => {
		const client = capture();
		const ctx = {client, protobuf: pb, uid: 'u', calendarId: 'cal'};
		await new MealPlanningCalendarEvent({date: '2026-11-29', title: 'New'}, ctx).save();
		await new MealPlanningCalendarEvent({identifier: 'e1', date: '2026-11-29', title: 'Old'}, ctx).save();
		const handlers = client.calls.map(c => decodeOps('PBCalendarOperationList', c).operations[0].metadata.handlerId);
		assert.deepStrictEqual(handlers, ['new-event', 'update-event']);
	});

	it('remove-recipe lists the recipe id in recipeIds', async () => {
		const client = capture();
		const recipe = new Recipe({identifier: 'r1', name: 'Soup'}, {client, protobuf: pb, uid: 'u', recipeDataId: 'rd'});
		await recipe.delete();
		const op = decodeOps('PBRecipeOperationList', client.calls[0]).operations[0];
		assert.strictEqual(op.metadata.handlerId, 'remove-recipe');
		assert.deepStrictEqual(op.recipeIds, ['r1']);
	});
});

describe('createList', () => {
	it('sends new-shopping-list with a 32-hex id and the name', async () => {
		const AnyList = require('../../lib');
		const any = new AnyList({email: 'x', password: 'y', credentialsFile: null});
		any.uid = 'u1';
		const client = capture();
		any.client = client;
		const id = await any.createList('  Staples ');
		assert.match(id, /^[0-9a-f]{32}$/);
		const op = decodeOps('PBListOperationList', client.calls[0]).operations[0];
		assert.strictEqual(client.calls[0].url, 'data/shopping-lists/update');
		assert.strictEqual(op.metadata.handlerId, 'new-shopping-list');
		assert.strictEqual(op.listId, id);
		assert.strictEqual(op.list.name, 'Staples');
		assert.strictEqual(op.list.creator, 'u1');
	});
});

describe('Ingredient getters', () => {
	it('exposes identifier and isHeading so a recipe can be re-saved intact', () => {
		const recipe = new Recipe({identifier: 'r1', name: 'Soup', ingredients: [
			{identifier: 'i1', name: 'Sauce', isHeading: true},
			{identifier: 'i2', name: 'salt', quantity: '1 tsp'},
		]}, {client: {}, protobuf: pb, uid: 'u', recipeDataId: 'rd'});
		assert.deepStrictEqual(recipe.ingredients.map(i => [i.identifier, i.isHeading]), [['i1', true], ['i2', false]]);
	});
});

describe('RecipeCollection operations', () => {
	const RecipeCollection = require('../../lib/recipe-collection');
	it('add and remove name the collection and the recipe, and never double-add', async () => {
		const client = capture();
		const col = new RecipeCollection({identifier: 'c1', name: 'Mum', recipeIds: ['r0']}, {client, protobuf: pb, uid: 'u', recipeDataId: 'rd'});
		await col.addRecipe('r1');
		await col.addRecipe('r1');
		await col.removeRecipe('r0');
		assert.strictEqual(client.calls.length, 2);
		const add = decodeOps('PBRecipeOperationList', client.calls[0]).operations[0];
		assert.strictEqual(add.metadata.handlerId, 'add-recipes-to-collection');
		assert.deepStrictEqual(add.recipeIds, ['r1']);
		assert.deepStrictEqual(add.recipeCollectionIds, ['c1']);
		const remove = decodeOps('PBRecipeOperationList', client.calls[1]).operations[0];
		assert.strictEqual(remove.metadata.handlerId, 'remove-recipes-from-collection');
		assert.deepStrictEqual(remove.recipeIds, ['r0']);
		assert.deepStrictEqual(remove.recipeCollection.recipeIds, ['r1']);
	});
});

describe('item categories', () => {
	const Item = require('../../lib/item');
	it('setCategory sends the captured two-operation shape and keeps every item field', async () => {
		const raw = pb.ListItem.decode(new pb.ListItem({
			identifier: 'i1', listId: 'L1', name: 'Milk', categoryMatchId: 'other', category: 'Other',
			photoIds: ['p1'], storeIds: ['s1'], productUpc: '123',
		}).toBuffer());
		const client = capture();
		const item = new Item(raw, {client, protobuf: pb, uid: 'u'});
		await item.setCategory({matchId: 'dairy', name: 'Dairy'});
		const {operations} = decodeOps('PBListOperationList', client.calls[0]);
		assert.deepStrictEqual(operations.map(o => o.metadata.handlerId), ['update-list-item-category-assignment', 'set-list-item-category-match-id']);
		assert.strictEqual(operations[0].listItem.categoryMatchId, 'other', 'first op carries the item before');
		assert.strictEqual(operations[1].listItem.categoryMatchId, 'dairy');
		assert.strictEqual(operations[1].originalValue, 'dairy', 'new match id goes in originalValue');
		assert.deepStrictEqual(operations[1].listItem.photoIds, ['p1'], 'fields the class does not model survive');
		assert.deepStrictEqual(operations[1].listItem.storeIds, ['s1']);
		assert.strictEqual(operations[1].listItem.productUpc, '123');
		assert.strictEqual(item.categoryMatchId, 'dairy');
	});

	it('getLists attaches the active category group, using systemCategory as the match id', () => {
		const AnyList = require('../../lib');
		const any = new AnyList({email: 'x', password: 'y', credentialsFile: null});
		any.lists = [{identifier: 'L1'}, {identifier: 'L2'}];
		any._attachCategories({
			shoppingListsResponse: {listResponses: [{listId: 'L1', categoryGroupResponses: [
				{categoryGroup: {identifier: 'g-store', categories: [{identifier: 'x9', name: 'Aisle 9', sortIndex: 1}]}},
				{categoryGroup: {identifier: 'g-main', categories: [
					{identifier: 'c2', name: 'Other', systemCategory: 'other', sortIndex: 9},
					{identifier: 'c1', name: 'Produce', systemCategory: 'produce', sortIndex: 1},
				]}},
			]}]},
			listSettingsResponse: {settings: [{listId: 'L1', listCategoryGroupId: 'g-main'}]},
		});
		assert.strictEqual(any.lists[0].categoryGroupId, 'g-main');
		assert.deepStrictEqual(any.lists[0].categories.map(c => [c.name, c.matchId]), [['Produce', 'produce'], ['Other', 'other']]);
		assert.strictEqual(any.lists[1].categories, undefined, 'lists without a response are left alone');
	});
});

describe('Item.save', () => {
	const Item = require('../../lib/item');
	it('sends each changed field once, never a nameless op, and does not resend earlier changes', async () => {
		const client = capture();
		const item = new Item({identifier: 'i1', name: 'Milk'}, {client, protobuf: pb, uid: 'u'});
		item.listId = 'L1';
		item.name = 'Oat milk';
		item.name = 'Oat milk 2L';
		await item.save();
		item.checked = true;
		await item.save();
		await item.save();
		const handlers = client.calls.map(c => decodeOps('PBListOperationList', c).operations.map(o => o.metadata.handlerId));
		assert.deepStrictEqual(handlers, [['set-list-item-name'], ['set-list-item-checked']]);
	});
});

describe('checkProcessed', () => {
	const {checkProcessed} = require('../../lib/processed');
	const opList = ids => ({operations: ids.map(operationId => ({metadata: {operationId}}))});
	const reply = ids => ({body: new pb.PBEditOperationResponse({processedOperations: ids}).toBuffer()});

	it('verifies when every sent operation is processed', () => {
		assert.deepStrictEqual(checkProcessed(pb, reply(['a', 'b']), opList(['a', 'b'])), {verified: true});
	});

	it('throws when AnyList leaves one of ours out', () => {
		assert.throws(() => checkProcessed(pb, reply(['a']), opList(['a', 'b'])), e => e.code === 'ANYLIST_NOT_PROCESSED');
	});

	it('is unverified, not an error, when the reply is empty or unreadable', () => {
		assert.deepStrictEqual(checkProcessed(pb, {body: Buffer.alloc(0)}, opList(['a'])), {verified: false});
		assert.deepStrictEqual(checkProcessed(pb, {}, opList(['a'])), {verified: false});
	});
});
