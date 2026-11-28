const crypto = require('crypto');

/** A 32-character hex id, the format AnyList uses. */
module.exports = () => crypto.randomUUID().replace(/-/g, '');
