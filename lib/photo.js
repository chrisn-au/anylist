const {Buffer} = require('buffer');
const FormData = require('form-data');
const uuid = require('./uuid');

/** Largest photo AnyList accepts. */
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/**
 * Sniff JPEG or PNG from the leading magic bytes.
 * @param {Buffer} buf
 * @returns {{ext: 'jpg'|'png', mimeType: string}|null}
 */
function detectImageType(buf) {
	if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
		return {ext: 'jpg', mimeType: 'image/jpeg'};
	}

	const pngSignature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
	if (buf.length >= 8 && pngSignature.every((b, i) => buf[i] === b)) {
		return {ext: 'png', mimeType: 'image/png'};
	}

	return null;
}

/**
 * Upload a photo to AnyList's storage and return its id. Either pass the
 * image bytes (JPEG or PNG) or an https URL that AnyList downloads itself.
 * The caller attaches the id to a recipe (`photoIds`) and saves it.
 *
 * @param {object} client AnyList client (needs `post`)
 * @param {Buffer|string} source image bytes, or an https URL
 * @returns {Promise<string>} the new photo id
 */
async function uploadPhoto(client, source) {
	const photoId = uuid();

	if (typeof source === 'string') {
		if (!/^https:\/\//i.test(source)) {
			throw new Error('Photo URL must be https.');
		}

		const form = new FormData();
		form.append('photo_url', source);
		form.append('photo_id', photoId);
		await client.post('data/photos/upload-url', {body: form});
		return photoId;
	}

	if (!Buffer.isBuffer(source)) {
		throw new TypeError('Photo must be a Buffer or an https URL.');
	}

	if (source.length > MAX_PHOTO_BYTES) {
		throw new Error(`Photo is larger than ${MAX_PHOTO_BYTES} bytes.`);
	}

	const type = detectImageType(source);
	if (!type) {
		throw new Error('Photo must be a JPEG or PNG image.');
	}

	// AnyList's clients always name the upload <id>.jpg, whatever the bytes are.
	const filename = `${photoId}.jpg`;
	const form = new FormData();
	form.append('filename', filename);
	form.append('photo', source, {filename, contentType: type.mimeType});
	await client.post('data/photos/upload', {body: form});
	return photoId;
}

module.exports = {uploadPhoto, detectImageType, MAX_PHOTO_BYTES};
