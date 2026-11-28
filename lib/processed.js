/**
 * AnyList answers each /update call with a PBEditOperationResponse that lists
 * the operation ids it processed. Checking that list confirms a write without
 * re-downloading the account (which AnyList rate-limits).
 *
 * Returns {verified: true} when every operation we sent is listed,
 * {verified: false} when the reply could not be read (callers should then
 * confirm another way), and throws when AnyList answered but left any of our
 * operations out.
 */
function checkProcessed(protobuf, response, operationList) {
	const sent = (operationList.operations || [])
		.map(operation => operation.metadata && operation.metadata.operationId)
		.filter(Boolean);
	let decoded;
	try {
		decoded = protobuf.PBEditOperationResponse.decode(response.body);
	} catch {
		return {verified: false};
	}

	const processed = new Set(decoded.processedOperations || []);
	if (processed.size === 0) {
		return {verified: false};
	}

	const missing = sent.filter(id => !processed.has(id));
	if (missing.length > 0) {
		const error = new Error(`AnyList did not process ${missing.length} of ${sent.length} operation(s).`);
		error.code = 'ANYLIST_NOT_PROCESSED';
		throw error;
	}

	return {verified: true};
}

module.exports = {checkProcessed};
