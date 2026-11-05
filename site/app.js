// Progressive enhancement: same-origin page links swap the document in place instead of reloading.
// Without this script every link still works as an ordinary navigation.
const root = document.documentElement;
const pages = new Map();

document.getElementById("theme").onclick = () => {
	root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
	localStorage.theme = root.dataset.theme;
};
if (matchMedia("(max-width: 60rem)").matches) document.querySelector(".menu").open = false;

// Copy buttons exist only with JavaScript, so they are added here rather than in the static HTML.
const addCopyButtons = () => {
	for (const pre of document.querySelectorAll("main pre:not(:has(> .copy))")) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "copy";
		button.textContent = "Copy";
		button.onclick = async () => {
			try {
				await navigator.clipboard.writeText(pre.querySelector("code").textContent.replace(/\n$/, ""));
				button.textContent = "Copied";
			} catch {
				button.textContent = "Copy failed";
			}
			setTimeout(() => {
				button.textContent = "Copy";
			}, 1500);
		};
		pre.append(button);
	}
};
addCopyButtons();

const fetchPage = (url) => {
	if (!pages.has(url)) {
		pages.set(
			url,
			fetch(url).then(async (response) => {
				if (!response.ok) throw new Error(`${response.status} ${url}`);
				const next = new DOMParser().parseFromString(await response.text(), "text/html");
				if (!next.querySelector("main") || !next.querySelector(".menu nav")) throw new Error(`unexpected page ${url}`);
				return next;
			}),
		);
	}
	return pages.get(url);
};

const show = (next, hash) => {
	// Clone so the cached document stays intact for later visits.
	document.title = next.title;
	document.querySelector("main").replaceWith(next.querySelector("main").cloneNode(true));
	document.querySelector(".menu nav").replaceWith(next.querySelector(".menu nav").cloneNode(true));
	const target = hash && document.getElementById(hash.slice(1));
	if (target) target.scrollIntoView();
	else scrollTo(0, 0);
	document.querySelector("main").focus({ preventScroll: true });
	addCopyButtons();
};

const navigate = async (href, push) => {
	const url = new URL(href);
	let next;
	try {
		next = await fetchPage(url.origin + url.pathname);
	} catch {
		location.href = href;
		return;
	}
	if (push) history.pushState(null, "", href);
	const render = () => show(next, url.hash);
	if (document.startViewTransition) document.startViewTransition(render);
	else render();
};

// Only same-origin page URLs are handled; assets, hash-only jumps, and modified clicks stay native.
const pageLink = (target) => {
	const link = target.closest("a[href]");
	if (!link || link.origin !== location.origin || link.target || !link.pathname.endsWith("/")) return null;
	return link;
};

document.addEventListener("click", (event) => {
	if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
		return;
	const link = pageLink(event.target);
	if (!link || link.pathname === location.pathname) return;
	event.preventDefault();
	navigate(link.href, true);
});

document.addEventListener("pointerover", (event) => {
	const link = pageLink(event.target);
	if (link && link.pathname !== location.pathname) fetchPage(link.origin + link.pathname).catch(() => {});
});

addEventListener("popstate", () => navigate(location.href, false));
