const assert = require('assert');
const protobuf = require('protobufjs');
const definitions = require('../../lib/definitions.json');
const Item = require('../../lib/item');
const MealPlanningCalendarEvent = require('../../lib/meal-planning-calendar-event');

const pb = protobuf.newBuilder({}).import(definitions).build('pcov.proto');
const ctx = {client: {}, protobuf: pb, uid: 'user-1', calendarId: 'cal-1'};

describe('MealPlanningCalendarEvent null dates (PR #56)', () => {
	it('keeps null date for queued entries instead of throwing or defaulting', () => {
		const ev = new MealPlanningCalendarEvent({identifier: 'q1', date: null, title: 'Soup'}, ctx);
		assert.strictEqual(ev.date, null);
		assert.strictEqual(ev.title, 'Soup');
	});

	it('still parses string and Date values', () => {
		const fromString = new MealPlanningCalendarEvent({date: '2026-03-01'}, ctx);
		assert.ok(fromString.date instanceof Date);
		const d = new Date('2026-03-02T00:00:00Z');
		assert.strictEqual(new MealPlanningCalendarEvent({date: d}, ctx).date, d);
	});

	it('encodes a null date without crashing', () => {
		const ev = new MealPlanningCalendarEvent({identifier: 'q1', date: null, title: 'Soup'}, ctx);
		const encoded = ev._encode();
		assert.strictEqual(encoded.title, 'Soup');
		assert.ok(!encoded.date);
	});
});

describe('Item recipe fields (PR #57)', () => {
	it('exposes recipeId, rawIngredient and ingredients', () => {
		const item = new Item({
			identifier: 'i1',
			name: 'Onion',
			recipeId: 'r1',
			rawIngredient: '1 onion, diced',
			ingredients: [{recipeId: 'r1', recipeName: 'Soup', eventId: 'e1', eventDate: '2026-03-01'}],
		}, ctx);
		assert.strictEqual(item.recipeId, 'r1');
		assert.strictEqual(item.rawIngredient, '1 onion, diced');
		assert.deepStrictEqual(item.ingredients, [{recipeId: 'r1', recipeName: 'Soup', eventId: 'e1', eventDate: '2026-03-01'}]);
	});

	it('defaults to null/empty for items without recipe data', () => {
		const item = new Item({identifier: 'i2', name: 'Milk'}, ctx);
		assert.strictEqual(item.recipeId, null);
		assert.strictEqual(item.rawIngredient, null);
		assert.deepStrictEqual(item.ingredients, []);
	});

	it('recipe fields are read-only', () => {
		const item = new Item({identifier: 'i3', name: 'Milk'}, ctx);
		assert.throws(() => {
			item.recipeId = 'x';
		}, /read-only/);
		assert.throws(() => {
			item.ingredients = [];
		}, /read-only/);
	});
});
