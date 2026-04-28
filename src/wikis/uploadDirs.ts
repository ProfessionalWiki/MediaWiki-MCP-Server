export interface UploadDirs {
	list(): readonly string[];
}

export class UploadDirsImpl implements UploadDirs {
	public constructor(private readonly dirs: readonly string[]) {}

	public list(): readonly string[] {
		return this.dirs;
	}
}
