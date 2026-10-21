// A file name cannot contain a colon: MediaWiki turns one into `-` on upload.
// So a title with a colon already names its namespace, in whatever spelling the
// wiki accepts (`Datei:`, `Image:`, `file:`), and is left for the wiki to read.
export function fileTitle(title: string): string {
	return title.includes(':') ? title : `File:${title}`;
}
