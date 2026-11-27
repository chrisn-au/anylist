const assert = require('assert');
const http = require('http');
const FormData = require('form-data');
const AnyList = require('../../lib');

// A 401 makes the client refresh its token and retry. The retry must re-send the
// whole multipart body; with a one-shot form-data stream it used to hang forever.
describe('401 refresh and retry (local server)', function () {
	this.timeout(5000);
	let server;
	let base;
	const seen = [];

	before(done => {
		server = http.createServer((req, res) => {
			const chunks = [];
			req.on('data', c => chunks.push(c));
			req.on('end', () => {
				seen.push({auth: req.headers.authorization, type: req.headers['content-type'], body: Buffer.concat(chunks).toString()});
				res.statusCode = seen.length === 1 ? 401 : 200;
				res.end('ok');
			});
		});
		server.listen(0, '127.0.0.1', () => {
			base = `http://127.0.0.1:${server.address().port}`;
			done();
		});
	});

	after(done => server.close(done));

	it('re-sends the full form body with the new token', async () => {
		const any = new AnyList({email: 'x', password: 'y', credentialsFile: null});
		any.accessToken = 'old';
		any.clientId = 'c';
		any._refreshTokens = async () => {
			any.accessToken = 'new';
		};

		const form = new FormData();
		form.append('operations', Buffer.from('payload-123'));
		await any.client.post('data/user-recipe-data/update', {prefixUrl: base, body: form});

		assert.strictEqual(seen.length, 2);
		assert.strictEqual(seen[0].auth, 'Bearer old');
		assert.strictEqual(seen[1].auth, 'Bearer new');
		assert.match(seen[1].type, /^multipart\/form-data; boundary=/);
		assert.ok(seen[1].body.includes('payload-123'), 'retry carried the body');
	});
});
