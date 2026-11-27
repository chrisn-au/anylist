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
