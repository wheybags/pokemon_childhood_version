import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { applyPatch, keyByte, md5, xorWithKey } from './patcher.template.js';

const MIN_CHUNK = 16;
const MAX_CHUNK = 512;
const BOUNDARY_MASK = 0xfc000000;
const MIN_COPY = 12;
const MAX_RUN_GAP = 2;

const GEAR = (() => {
	const table = new Uint32Array(256);
	let s = 0x9e3779b9;
	for (let i = 0; i < 256; i++) {
		s = (s + 0x6d2b79f5) | 0;
		let z = s;
		z = Math.imul(z ^ (z >>> 15), z | 1);
		z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
		table[i] = (z ^ (z >>> 14)) >>> 0;
	}
	return table;
})();

function chunk(data) {
	const chunks = [];
	let start = 0;
	let fp = 0;
	for (let i = 0; i < data.length; i++) {
		fp = ((fp << 1) + GEAR[data[i]]) >>> 0;
		const len = i + 1 - start;
		if ((len >= MIN_CHUNK && (fp & BOUNDARY_MASK) === 0) || len >= MAX_CHUNK) {
			chunks.push([start, len]);
			start = i + 1;
		}
	}
	if (start < data.length) {
		chunks.push([start, data.length - start]);
	}
	return chunks;
}

function chunkKey(data, start, len) {
	let h = 0x811c9dc5;
	for (let i = start; i < start + len; i++) {
		h = Math.imul(h ^ data[i], 0x01000193);
	}
	return `${h >>> 0}:${len}`;
}

function rangesEqual(a, aStart, b, bStart, len) {
	for (let i = 0; i < len; i++) {
		if (a[aStart + i] !== b[bStart + i]) {
			return false;
		}
	}
	return true;
}

function mergeSegments(segs) {
	const out = [];
	for (const seg of segs) {
		const last = out[out.length - 1];
		if (last && last.src < 0 && seg.src < 0) {
			last.len += seg.len;
		} else if (last && last.src >= 0 && seg.src >= 0 && last.src + last.len === seg.src) {
			last.len += seg.len;
		} else {
			out.push({ ...seg });
		}
	}
	return out;
}

function buildSegments(orig, target) {
	const index = new Map();
	for (const [start, len] of chunk(orig)) {
		const key = chunkKey(orig, start, len);
		if (!index.has(key)) {
			index.set(key, []);
		}
		index.get(key).push(start);
	}

	let segs = [];
	let prevEnd = -1;
	for (const [t, len] of chunk(target)) {
		let src = -1;
		for (const candidate of index.get(chunkKey(target, t, len)) ?? []) {
			if (!rangesEqual(orig, candidate, target, t, len)) {
				continue;
			}
			if (src < 0) {
				src = candidate;
			}
			if (candidate === prevEnd) {
				src = candidate;
				break;
			}
		}
		segs.push({ t, len, src });
		prevEnd = src >= 0 ? src + len : -1;
	}
	segs = mergeSegments(segs);

	for (let i = 0; i < segs.length; i++) {
		const seg = segs[i];
		if (seg.src >= 0) {
			continue;
		}
		const prev = segs[i - 1];
		while (prev && seg.len > 0 && prev.src + prev.len < orig.length && orig[prev.src + prev.len] === target[seg.t]) {
			prev.len++;
			seg.t++;
			seg.len--;
		}
		const next = segs[i + 1];
		while (next && seg.len > 0 && next.src > 0 && orig[next.src - 1] === target[seg.t + seg.len - 1]) {
			next.src--;
			next.t--;
			next.len++;
			seg.len--;
		}
	}
	segs = mergeSegments(segs.filter((seg) => seg.len > 0));

	for (let i = 0; i < segs.length; i++) {
		const seg = segs[i];
		const prev = segs[i - 1];
		const next = segs[i + 1];
		if (seg.src >= 0 && seg.len < MIN_COPY && (!prev || prev.src < 0) && (!next || next.src < 0) && (prev || next)) {
			seg.src = -1;
		}
	}
	return mergeSegments(segs);
}

function randomUint32() {
	return crypto.getRandomValues(new Uint32Array(1))[0];
}

function pickKeyOffset(orig, len) {
	const scratch = new Uint8Array(len);
	for (;;) {
		const offset = randomUint32() % orig.length;
		const key = new Uint8Array(len);
		xorWithKey(orig, offset, scratch, key, 0);
		if (len === 1 || key.some((b) => b !== key[0])) {
			return offset;
		}
	}
}

class ByteWriter {
	constructor() {
		this.parts = [];
	}

	varint(value) {
		const bytes = [];
		while (value >= 0x80) {
			bytes.push((value % 0x80) | 0x80);
			value = Math.floor(value / 0x80);
		}
		bytes.push(value);
		this.parts.push(Uint8Array.from(bytes));
	}

	bytes(data) {
		this.parts.push(data);
	}

	finish() {
		const total = this.parts.reduce((sum, p) => sum + p.length, 0);
		const out = new Uint8Array(total);
		let pos = 0;
		for (const part of this.parts) {
			out.set(part, pos);
			pos += part.length;
		}
		return out;
	}
}

function findDiffRuns(orig, target, t, len, src) {
	const runs = [];
	let cost = 0;
	let cursor = 0;
	let run = null;
	for (let p = 0; p < len; p++) {
		if (orig[src + p] === target[t + p]) {
			continue;
		}
		if (run && p - (run.start + run.len) <= MAX_RUN_GAP) {
			run.len = p + 1 - run.start;
		} else {
			if (run) {
				runs.push(run);
			}
			run = { start: p, len: 1 };
		}
	}
	if (run) {
		runs.push(run);
	}
	for (const r of runs) {
		cost += varintSize(r.start - cursor) + varintSize(r.len) + r.len;
		cursor = r.start + r.len;
	}
	return { runs, cost: cost + varintSize(runs.length) };
}

function varintSize(value) {
	let size = 1;
	while (value >= 0x80) {
		value = Math.floor(value / 0x80);
		size++;
	}
	return size;
}

function planOps(orig, target, segs) {
	return segs.map((seg, i) => {
		if (seg.src >= 0) {
			return { type: 0, ...seg };
		}

		const prev = segs[i - 1];
		const next = segs[i + 1];
		const shifts = [];
		if (prev && prev.src >= 0) {
			shifts.push(prev.src + prev.len);
		}
		if (next && next.src >= 0) {
			shifts.push(next.src - seg.len);
		}

		let best = { type: 1, ...seg, cost: varintSize(seg.len * 4 + 1) + 3 + seg.len };
		for (const src of shifts) {
			if (src < 0 || src + seg.len > orig.length) {
				continue;
			}
			const { runs, cost } = findDiffRuns(orig, target, seg.t, seg.len, src);
			const total = varintSize(seg.len * 4 + 2) + varintSize(src) + cost;
			if (total < best.cost) {
				best = { type: 2, t: seg.t, len: seg.len, src, runs, cost: total };
			}
		}
		return best;
	});
}

function makePatch(orig, target) {
	const writer = new ByteWriter();
	writer.varint(target.length);

	for (const op of planOps(orig, target, buildSegments(orig, target))) {
		writer.varint(op.len * 4 + op.type);
		if (op.type === 0) {
			writer.varint(op.src);
		} else if (op.type === 1) {
			const keyOffset = pickKeyOffset(orig, op.len);
			const encoded = new Uint8Array(op.len);
			xorWithKey(orig, keyOffset, target.subarray(op.t, op.t + op.len), encoded, 0);
			writer.varint(keyOffset);
			writer.bytes(encoded);
		} else {
			writer.varint(op.src);
			writer.varint(op.runs.length);
			let cursor = 0;
			for (const run of op.runs) {
				writer.varint(run.start - cursor);
				writer.varint(run.len);
				const encoded = new Uint8Array(run.len);
				for (let i = 0; i < run.len; i++) {
					encoded[i] = target[op.t + run.start + i] ^ keyByte(orig, op.src + run.start + i);
				}
				writer.bytes(encoded);
				cursor = run.start + run.len;
			}
		}
	}
	return writer.finish();
}

function bytesToBase64(bytes) {
	let binary = '';
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

function generatePatchesSource(variants) {
	const entries = [];
	for (const { name, filename, origPath, builtPath } of variants) {
		const orig = new Uint8Array(readFileSync(origPath));
		const target = new Uint8Array(readFileSync(builtPath));
		const patch = makePatch(orig, target);

		if (md5(applyPatch(orig, patch)) !== md5(target)) {
			throw new Error(`${name}: patch does not reproduce target`);
		}
		console.log(`${name}: ${md5(orig)} -> ${md5(target)}, patch ${patch.length} bytes`);

		const lines = bytesToBase64(patch).match(/.{1,120}/g).map((line) => `\t\t\t'${line}',`);
		entries.push(
			`\t'${md5(orig)}': {\n\t\tname: '${name}',\n\t\tfilename: '${filename}',\n\t\toutputMd5: '${md5(target)}',\n\t\tdata: [\n${lines.join('\n')}\n\t\t].join(''),\n\t},`,
		);
	}
	return `const PATCHES = {\n${entries.join('\n')}\n};\n`;
}

function runMake(origRed, origBlue, builtRed, builtBlue) {
	const root = fileURLToPath(new URL('..', import.meta.url));
	const patchesSource = generatePatchesSource([
		{ name: 'red', filename: 'pokered.gbc', origPath: origRed, builtPath: builtRed ?? `${root}pokered.gbc` },
		{ name: 'blue', filename: 'pokeblue.gbc', origPath: origBlue, builtPath: builtBlue ?? `${root}pokeblue.gbc` },
	]);

	const source = readFileSync(new URL('./patcher.template.js', import.meta.url), 'utf8');
	const pattern = /const PATCHES = \{[\s\S]*?\n\};\n/;
	if (!pattern.test(source)) {
		throw new Error('PATCHES block not found in patcher.template.js');
	}
	writeFileSync(new URL('./patcher.js', import.meta.url), source.replace(pattern, () => patchesSource));
}

async function runApply(input, output) {
	const { patchRom } = await import('./patcher.js');
	const result = patchRom(new Uint8Array(readFileSync(input)));
	const outPath = output ?? result.filename;
	writeFileSync(outPath, result.data);
	console.log(`Patched ${result.name} ROM written to ${outPath}`);
}

const usage = `usage:
  cli.js apply <original rom> [output path]
  cli.js make <original red rom> <original blue rom> [built pokered.gbc] [built pokeblue.gbc]`;

const [command, ...args] = process.argv.slice(2);
try {
	if (command === 'apply' && args.length >= 1) {
		await runApply(...args);
	} else if (command === 'make' && args.length >= 2) {
		runMake(...args);
	} else {
		console.error(usage);
		process.exit(1);
	}
} catch (e) {
	console.error(e.message);
	process.exit(1);
}
