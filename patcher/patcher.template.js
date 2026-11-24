const SHIFTS = [
	7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
	5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
	4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
	6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

export function md5(bytes) {
	const n = bytes.length;
	const padded = new Uint8Array((((n + 8) >>> 6) + 1) * 64);
	padded.set(bytes);
	padded[n] = 0x80;

	const view = new DataView(padded.buffer);
	view.setUint32(padded.length - 8, (n << 3) >>> 0, true);
	view.setUint32(padded.length - 4, Math.floor(n / 2 ** 29), true);

	let a0 = 0x67452301;
	let b0 = 0xefcdab89 | 0;
	let c0 = 0x98badcfe | 0;
	let d0 = 0x10325476;

	for (let block = 0; block < padded.length; block += 64) {
		let a = a0;
		let b = b0;
		let c = c0;
		let d = d0;

		for (let i = 0; i < 64; i++) {
			let f;
			let g;
			if (i < 16) {
				f = (b & c) | (~b & d);
				g = i;
			} else if (i < 32) {
				f = (d & b) | (~d & c);
				g = (5 * i + 1) % 16;
			} else if (i < 48) {
				f = b ^ c ^ d;
				g = (3 * i + 5) % 16;
			} else {
				f = c ^ (b | ~d);
				g = (7 * i) % 16;
			}

			f = (f + a + K[i] + view.getUint32(block + g * 4, true)) | 0;
			a = d;
			d = c;
			c = b;
			b = (b + ((f << SHIFTS[i]) | (f >>> (32 - SHIFTS[i])))) | 0;
		}

		a0 = (a0 + a) | 0;
		b0 = (b0 + b) | 0;
		c0 = (c0 + c) | 0;
		d0 = (d0 + d) | 0;
	}

	const out = new DataView(new ArrayBuffer(16));
	out.setInt32(0, a0, true);
	out.setInt32(4, b0, true);
	out.setInt32(8, c0, true);
	out.setInt32(12, d0, true);

	let hex = '';
	for (let i = 0; i < 16; i++) {
		hex += out.getUint8(i).toString(16).padStart(2, '0');
	}
	return hex;
}

export function xorWithKey(orig, keyOffset, input, output, outputPos) {
	const n = orig.length;
	let k = keyOffset;
	for (let i = 0; i < input.length; i++) {
		while (orig[k] === 0) {
			k = (k + 1) % n;
		}
		output[outputPos + i] = input[i] ^ orig[k];
		k = (k + 1) % n;
	}
}

export function keyByte(orig, position) {
	const n = orig.length;
	let k = position % n;
	while (orig[k] === 0) {
		k = (k + 1) % n;
	}
	return orig[k];
}

export function applyPatch(orig, patch) {
	let pos = 0;

	const readVarint = () => {
		let value = 0;
		let shift = 0;
		let byte;
		do {
			if (pos >= patch.length) {
				throw new Error('Truncated patch');
			}
			byte = patch[pos++];
			value += (byte & 0x7f) * 2 ** shift;
			shift += 7;
		} while (byte & 0x80);
		return value;
	};

	const out = new Uint8Array(readVarint());
	let outPos = 0;

	while (pos < patch.length) {
		const tag = readVarint();
		const type = tag & 3;
		const len = Math.floor(tag / 4);
		const offset = readVarint();

		if (outPos + len > out.length) {
			throw new Error('Corrupt patch: output overrun');
		}

		if (type === 1) {
			if (pos + len > patch.length) {
				throw new Error('Truncated patch');
			}
			xorWithKey(orig, offset, patch.subarray(pos, pos + len), out, outPos);
			pos += len;
		} else if (type === 0 || type === 2) {
			if (offset + len > orig.length) {
				throw new Error('Corrupt patch: copy out of range');
			}
			out.set(orig.subarray(offset, offset + len), outPos);

			if (type === 2) {
				let p = 0;
				for (let runs = readVarint(); runs > 0; runs--) {
					p += readVarint();
					const runLen = readVarint();
					if (p + runLen > len || pos + runLen > patch.length) {
						throw new Error('Corrupt patch: diff out of range');
					}
					for (let i = 0; i < runLen; i++) {
						out[outPos + p + i] = patch[pos + i] ^ keyByte(orig, offset + p + i);
					}
					pos += runLen;
					p += runLen;
				}
			}
		} else {
			throw new Error('Corrupt patch: unknown op');
		}
		outPos += len;
	}

	if (outPos !== out.length) {
		throw new Error('Corrupt patch: output size mismatch');
	}

	return out;
}

function base64ToBytes(base64) {
	const binary = atob(base64);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		out[i] = binary.charCodeAt(i);
	}
	return out;
}

export function patchRom(rom) {
	const inputMd5 = md5(rom);
	const entry = PATCHES[inputMd5];
	if (!entry) {
		const expected = Object.entries(PATCHES).map(([hash, patch]) => `${patch.name}: ${hash}`).join(', ');
		throw new Error(`Unrecognised ROM, expected an original Pokemon Red or Blue (USA, Europe) ROM with md5 (${expected})`);
	}

	const data = applyPatch(rom, base64ToBytes(entry.data));
	const outputMd5 = md5(data);
	if (outputMd5 !== entry.outputMd5) {
		throw new Error(`Patched ROM failed verification (md5 ${outputMd5})`);
	}

	return { name: entry.name, filename: entry.filename, data };
}

const PATCHES = {
};
