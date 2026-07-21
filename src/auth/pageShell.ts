// Self-contained styled HTML shell for the OAuth flow's user-facing pages
// (the hosted-proxy consent/status pages and the stdio loopback login pages).
// No external assets: colours are hardcoded Wikimedia Codex design-token values
// (light + dark via the CSS light-dark() function) and the icons are inlined
// Codex (WikimediaUI) glyphs. The Codex icon set is MIT licensed
// (https://github.com/wikimedia/codex, packages/codex-icons), so inlining the
// raw path data here is permitted. Exact token values mirror Codex's
// theme-wikimedia-ui tokens; re-confirm against the current Codex token
// reference if Codex updates them.

export function esc(s: string): string {
	return s.replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
	);
}

export type IconName = 'lock' | 'cancel' | 'error' | 'success';
export type IconAccent = 'base' | 'subtle' | 'error' | 'success';

// Verbatim Codex icon path data (20x20 viewBox): cdxIconLock, cdxIconCancel,
// cdxIconError, cdxIconSuccess.
const ICON_PATHS: Record<IconName, string> = {
	lock: 'M11 15H9v-3h2z M10 1a4 4 0 0 1 4 4v3h3v11H3V8h3V5a4 4 0 0 1 4-4M5 17h10v-7H5zm5-14a2 2 0 0 0-2 2v3h4V5a2 2 0 0 0-2-2',
	cancel:
		'M10 1a9 9 0 1 1 0 18 9 9 0 0 1 0-18M4.394 5.806A6.97 6.97 0 0 0 3 10a7 7 0 0 0 11.193 5.605l-9.8-9.8ZM10 3a6.97 6.97 0 0 0-4.191 1.392l9.797 9.798A7 7 0 0 0 10 3',
	error: 'M19 6.4v7.199L13.6 19H6.4L1 13.599v-7.2L6.4 1h7.2zM9 14v2h2v-2zm0-9v7h2V5z',
	success:
		'M10 1a9 9 0 1 1 0 18 9 9 0 0 1 0-18M8.823 11.118 6.8 9.6l-1.2 1.6 2.8 2.1 1.381-.175 4.624-5.781-1.561-1.25z',
};

export function renderIcon(name: IconName, accent: IconAccent = 'base'): string {
	return `<div class="pg-icon pg-icon--${accent}"><svg viewBox="0 0 20 20" width="56" height="56" fill="currentColor" aria-hidden="true"><path d="${ICON_PATHS[name]}"/></svg></div>`;
}

// Each colour token declares a plain light value first (the fallback for
// browsers without light-dark()) then the light-dark() override.
const STYLE = `
:root{color-scheme: light dark}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
.pg-wrap{
--c-base:#202122;--c-base:light-dark(#202122,#eaecf0);
--c-subtle:#54595d;--c-subtle:light-dark(#54595d,#a2a9b1);
--c-progressive:#3366cc;--c-progressive:light-dark(#3366cc,#88a3e8);
--c-progressive-hover:#3056a9;--c-progressive-hover:light-dark(#3056a9,#a6bbf5);
--c-inverted:#fff;--c-inverted:light-dark(#fff,#101418);
--c-error:#bf3c2c;--c-error:light-dark(#bf3c2c,#fd7865);
--c-success:#14866d;--c-success:light-dark(#14866d,#2cb491);
--page-bg:#f8f9fa;--page-bg:light-dark(#f8f9fa,#101418);
--card-bg:#fff;--card-bg:light-dark(#fff,#202122);
--inset-bg:#f8f9fa;--inset-bg:light-dark(#f8f9fa,#101418);
--bd-base:#a2a9b1;--bd-base:light-dark(#a2a9b1,#72777d);
--bd-subtle:#c8ccd1;--bd-subtle:light-dark(#c8ccd1,#54595d);
--btn-normal-bg:#f8f9fa;--btn-normal-bg:light-dark(#f8f9fa,#27292d);
--btn-normal-bg-hover:#eaecf0;--btn-normal-bg-hover:light-dark(#eaecf0,#404244);
--focus:#3366cc;--focus:light-dark(#3366cc,#6485d1);
font-family:-apple-system,system-ui,'Segoe UI',sans-serif;
min-height:100vh;display:flex;align-items:center;justify-content:center;
background:var(--page-bg);padding:24px;color:var(--c-base)}
.pg-card{max-width:32rem;width:100%;background:var(--card-bg);border:1px solid var(--bd-subtle);border-radius:2px;box-shadow:0 1px 2px light-dark(rgba(0,0,0,.08),rgba(0,0,0,.4));padding:32px;text-align:center}
.pg-icon{margin:0 0 12px;color:var(--c-base)}
.pg-icon svg{display:block;margin:0 auto}
.pg-icon--subtle{color:var(--c-subtle)}
.pg-icon--error{color:var(--c-error)}
.pg-icon--success{color:var(--c-success)}
.pg-title{font-size:1.25rem;font-weight:700;line-height:1.875rem;margin:0 0 8px}
.pg-verified{font-size:.8125rem;line-height:1.25rem;color:var(--c-success);margin:0 0 8px}
.pg-lead{font-size:.875rem;line-height:1.375rem;margin:0}
.pg-actions{display:flex;flex-wrap:wrap;gap:12px;margin:16px 0 0}
.pg-btn{flex:1;display:inline-flex;align-items:center;justify-content:center;min-height:32px;padding:0 11px;border:1px solid;border-radius:2px;font-size:.875rem;font-weight:700;font-family:inherit;cursor:pointer;transition:background-color .1s,color .1s,border-color .1s,box-shadow .1s}
.pg-btn:focus-visible{outline:1px solid transparent;box-shadow:inset 0 0 0 1px var(--focus)}
.pg-primary{background:var(--c-progressive);border-color:transparent;color:var(--c-inverted)}
.pg-primary:hover{background:var(--c-progressive-hover)}
.pg-primary:focus-visible{box-shadow:inset 0 0 0 1px var(--c-progressive),inset 0 0 0 2px var(--c-inverted)}
.pg-neutral{background:var(--btn-normal-bg);border-color:var(--bd-base);color:var(--c-base)}
.pg-neutral:hover{background:var(--btn-normal-bg-hover)}
.pg-note{font-size:.8125rem;line-height:1.25rem;color:var(--c-subtle);margin:16px 0 0}
.pg-mono{font-family:ui-monospace,'SFMono-Regular',monospace;font-size:.8125rem;color:var(--c-subtle);background:var(--inset-bg);border:1px solid var(--bd-subtle);border-radius:2px;padding:8px;margin:16px 0 0;word-break:break-word}
`;

export function renderPage(o: {
	title: string;
	icon: { name: IconName; accent?: IconAccent };
	body: string;
}): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(o.title)}</title><style>${STYLE}</style></head><body><main class="pg-wrap"><div class="pg-card">${renderIcon(o.icon.name, o.icon.accent)}<h1 class="pg-title">${esc(o.title)}</h1>${o.body}</div></main></body></html>`;
}
