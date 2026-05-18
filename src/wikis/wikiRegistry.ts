import type { WikiConfig } from '../config/loadConfig.js';

export interface WikiRegistry {
	getAll(): Readonly<Record<string, WikiConfig>>;
	get(key: string): Readonly<WikiConfig> | undefined;
	add(key: string, config: WikiConfig): void;
	remove(key: string): void;
	isManagementAllowed(): boolean;
}

export class DuplicateWikiKeyError extends Error {
	public constructor(key: string) {
		super(`Wiki "${key}" already exists in configuration`);
		this.name = 'DuplicateWikiKeyError';
	}
}

export class WikiRegistryImpl implements WikiRegistry {
	public constructor(
		private readonly wikis: Record<string, WikiConfig>,
		private readonly managementAllowed: boolean,
	) {}

	public getAll(): Readonly<Record<string, WikiConfig>> {
		return this.wikis;
	}

	public get(key: string): Readonly<WikiConfig> | undefined {
		// Own-key lookup only: a bare bracket access would resolve inherited
		// Object.prototype members ('constructor', '__proto__', 'toString', …)
		// to truthy values, letting bogus keys pass an existence check.
		return Object.hasOwn(this.wikis, key) ? this.wikis[key] : undefined;
	}

	public add(key: string, config: WikiConfig): void {
		if (!key || key.trim() === '') {
			throw new Error('Wiki key cannot be empty');
		}
		// Reject keys that would mutate the prototype chain when assigned via
		// bracket notation, or otherwise alias an inherited member.
		if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
			throw new Error(`Wiki key "${key}" is not allowed`);
		}
		if (Object.hasOwn(this.wikis, key)) {
			throw new DuplicateWikiKeyError(key);
		}
		this.wikis[key] = config;
	}

	public remove(key: string): void {
		delete this.wikis[key];
	}

	public isManagementAllowed(): boolean {
		return this.managementAllowed;
	}
}
