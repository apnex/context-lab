// paths - containment, the one rule every path a pack or a hook names must keep.

import fs from "node:fs";
import path from "node:path";

/** True if child is parent or lies under it, compared on separators, not string prefixes. */
export function isInside(child: string, parent: string): boolean {
	const rel = path.relative(path.resolve(parent), path.resolve(child));
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** A relative path that cannot leave the directory it is resolved against. */
export function isContainedRelative(p: string): boolean {
	return !path.isAbsolute(p) && !path.normalize(p).split(path.sep).includes("..");
}

/** The real path of a directory that may not exist yet: its nearest existing ancestor, resolved, plus the rest. */
export function realPathOf(p: string): string {
	const abs = path.resolve(p);
	let d = abs;
	const rest: string[] = [];
	while (!fs.existsSync(d)) {
		rest.unshift(path.basename(d));
		d = path.dirname(d);
	}
	return path.join(fs.realpathSync(d), ...rest);
}

/**
 * Copy a directory, replacing every symbolic link with a copy of what it points to, provided that
 * lies inside root; a link that points outside root, or cannot be followed, is refused.
 */
export function copyContained(from: string, to: string, root: string = from): void {
	const realRoot = fs.realpathSync(root);
	fs.mkdirSync(to, { recursive: true });
	for (const e of fs.readdirSync(from, { withFileTypes: true })) {
		const src = path.join(from, e.name);
		const dst = path.join(to, e.name);
		let real: string;
		try {
			real = fs.realpathSync(src);
		} catch {
			throw new Error(`${src} is a link that cannot be followed`);
		}
		if (!isInside(real, realRoot)) throw new Error(`${src} links outside ${root}, to ${real}`);
		const st = fs.statSync(real);
		if (st.isDirectory()) copyContained(real, dst, root);
		else if (st.isFile()) fs.copyFileSync(real, dst);
	}
}
