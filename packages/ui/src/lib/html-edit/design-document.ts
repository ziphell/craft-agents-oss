/**
 * Builds the srcdoc document the visual HTML editor runs in.
 *
 * The frame is deliberately cross-origin (`allow-scripts`, no `allow-same-origin`),
 * so nothing outside can read its DOM — including us. A small probe script is
 * injected instead, and it talks to the parent exclusively through postMessage:
 * hover/click selection is drawn in there, text edits arrive as `{ path, text }`,
 * and the parent patches the raw source.
 *
 * A keystroke the *app* owns and the frame does not — ⌘S to save, ⌘Z / ⌘Y for the
 * history the parent keeps — is forwarded the same way, because a key pressed in
 * here belongs to this document and reaches no listener on the window around it.
 *
 * Why the origin is opaque: this document is whatever was previewed — an agent's
 * output, an extracted email, a page fetched from somewhere. Giving it scripts
 * *and* the app's origin would let it reach `window.parent.electronAPI` and write
 * files. An opaque origin is what makes returning edits through postMessage the
 * only channel, which is what the token below is for.
 *
 * The preview's own `<meta http-equiv="Content-Security-Policy">` still applies
 * and can forbid inline scripts; when that happens the probe never runs, so the
 * parent treats a missing `ready` handshake as exactly that and says so.
 */

/** Message key every probe message and parent command carries. */
export const HTML_EDIT_MESSAGE_KEY = '__craftHtmlEdit'

// Keep this a plain string: no backticks / ${} / '</script>' inside.
// `__TOKEN__` is replaced with a per-instance random token, `__RESTORE_SCROLL__` with a 0..1
// scroll fraction (or 0) and `__RESTORE_SCROLL_PX__` with a pixel offset (or 0) at build time.
const DESIGN_SCRIPT = `(function () {
	var TOKEN = '__TOKEN__';
	var RESTORE_SCROLL = __RESTORE_SCROLL__;
	var RESTORE_SCROLL_PX = __RESTORE_SCROLL_PX__;
	if (window.top === window.self) { return; }
	var d = document;
	var HOVER_COLOR = '#3b82f6';
	var SEL_COLOR = '#22c55e';   // selection box: green
	var EDIT_COLOR = '#f97316';  // text-editing box: orange
	function boot() {
	function post(action, payload) {
		try {
			var msg = { __craftHtmlEdit: TOKEN, action: action };
			if (payload) { for (var k in payload) { msg[k] = payload[k]; } }
			window.parent.postMessage(msg, '*');
		} catch (e) { /* parent gone */ }
	}
	var EDITABLE_TAGS = 'A,P,SPAN,DIV,LI,TD,TH,H1,H2,H3,H4,H5,H6,LABEL,BLOCKQUOTE,CITE,EM,STRONG,B,I,U,S,SMALL,CODE,BUTTON,CAPTION,DT,DD,FIGCAPTION'.split(',');
	var editableSet = {};
	for (var i = 0; i < EDITABLE_TAGS.length; i++) { editableSet[EDITABLE_TAGS[i]] = true; }

	function elIndex(el) {
		var p = el.parentElement;
		if (!p) { return -1; }
		var idx = 0, c = p.firstElementChild;
		while (c) { if (c === el) { return idx; } idx++; c = c.nextElementSibling; }
		return -1;
	}
	function pathOf(el) {
		var parts = [], n = el;
		while (n && n.parentElement && n !== d.documentElement) {
			parts.unshift(elIndex(n));
			n = n.parentElement;
		}
		return parts.length ? parts.join('/') : null;
	}
	function isTextOnly(el) {
		var t = el.tagName ? el.tagName.toUpperCase() : '';
		if (!editableSet[t]) { return false; }
		var c = el.firstChild;
		while (c) { if (c.nodeType !== 3) { return false; } c = c.nextSibling; }
		return true;
	}
	// An element whose content was fully cleared may still hold leftover marker
	// nodes (a <br> keeps the caret box in contenteditable) — treat that state
	// as text-editable so the user can click back in and type again.
	function isEditableOrEmpty(el) {
		if (isTextOnly(el)) { return true; }
		if ((el.textContent || '').trim() !== '') { return false; }
		var c = el.firstChild;
		while (c) {
			if (c.nodeType === 1 && c.tagName !== 'BR') { return false; }
			c = c.nextSibling;
		}
		return true;
	}
	function isIgnored(t) { return !t || t === d.body || t === d.documentElement || !t.tagName; }

	var hoverEl = null, selEl = null;
	function applyOutline(el, color, w) { el.style.outline = w + 'px solid ' + color; el.style.outlineOffset = '1px'; }
	function clearOutline(el) { el.style.outline = ''; el.style.outlineOffset = ''; }
	function setHover(el) {
		if (el === hoverEl) { return; }
		if (hoverEl && hoverEl !== selEl) { clearOutline(hoverEl); }
		hoverEl = el;
		if (el !== selEl) { applyOutline(el, HOVER_COLOR, 1); }
	}
	function clearHover() {
		if (hoverEl && hoverEl !== selEl) { clearOutline(hoverEl); }
		hoverEl = null;
	}
	/**
	 * Where the selected element is on screen, in the frame's own viewport coordinates.
	 *
	 * The parent draws its controls just above this, so it needs the box rather than a picture of
	 * it: the frame fills the same box the parent lays the controls over, so the numbers carry
	 * across unchanged. Reported again on scroll and resize — the element has not moved, but where
	 * it *is* has, and a bar left behind would point at nothing.
	 */
	function rectOf(el) {
		var r = el.getBoundingClientRect();
		return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
	}
	// Decoration state comes straight from the raw style attribute text — see
	// readInlineDeco. No per-element bookkeeping is needed because writes below
	// always serialize to a single longhand form.
	function readInlineDeco(el) {
		if (!el || !el.getAttribute) { return []; }
		// Scan the RAW style attribute (not CSSOM): the browser may store the
		// decoration as shorthand "text-decoration: …" or longhand
		// "text-decoration-line: …" and CSSOM getters behave inconsistently
		// across those forms, while the attribute text reflects what persists.
		var attr = (el.getAttribute('style') || '').toLowerCase();
		if (!attr) { return []; }
		var out = [];
		var re = /(?:^|;)\\s*text-decoration(?:-line)?\\s*:\\s*([^;]*)/g;
		var m;
		while ((m = re.exec(attr)) !== null) {
			var val = m[1];
			if (val.indexOf('underline') !== -1 && out.indexOf('underline') === -1) { out.push('underline'); }
			if (val.indexOf('line-through') !== -1 && out.indexOf('line-through') === -1) { out.push('line-through'); }
		}
		return out;
	}
	function decorList(el) {
		return readInlineDeco(el);
	}
	function writeDeco(el, list) {
		if (!el) { return; }
		var v = list.length ? list.join(' ') : 'none';
		// Write ONLY the longhand. Clearing the shorthand first prevents the
		// browser keeping both "text-decoration: …" and
		// "text-decoration-line: …" in the attribute (duplicated forms broke
		// detection after reloads).
		try { el.style.textDecoration = ''; } catch (err) { /* ignore */ }
		el.style.textDecorationLine = v;
	}
	function styleState(el) {
		if (!el || !el.style) { return null; }
		var cs = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
		var fw = el.style.fontWeight || (cs ? cs.fontWeight : '') || '';
		var fs = el.style.fontStyle || (cs ? cs.fontStyle : '') || '';
		var deco = decorList(el);
		return {
			bold: fw === 'bold' || (/^\\d+$/.test(fw) && parseFloat(fw) >= 600),
			italic: fs === 'italic',
			underline: deco.indexOf('underline') !== -1,
			strike: deco.indexOf('line-through') !== -1
		};
	}
	function postSelection(extra) {
		if (!selEl) { return; }
		var payload = {
			path: pathOf(selEl),
			tag: (selEl.tagName || '').toLowerCase(),
			rect: rectOf(selEl),
			style: styleState(selEl)
		};
		if (extra) { for (var k in extra) { payload[k] = extra[k]; } }
		post('select', payload);
	}
	function setSelect(el) {
		if (el === selEl) { return; }
		if (selEl && selEl !== hoverEl) { clearOutline(selEl); }
		selEl = el;
		applyOutline(el, SEL_COLOR, 2);
		postSelection(null);
	}
	function clearSelection() {
		if (selEl) { clearOutline(selEl); }
		selEl = null;
		if (hoverEl) { clearOutline(hoverEl); hoverEl = null; }
		post('clear-select', {});
	}

	// The page can move under the selection without the selection changing — a scroll, a resize, a
	// late-loading font. Follow it, on an animation frame so a scroll does not post per pixel.
	var followRaf = false;
	function followSelection() {
		if (!selEl || followRaf) { return; }
		followRaf = true;
		requestAnimationFrame(function () {
			followRaf = false;
			if (selEl) { post('select-move', { rect: rectOf(selEl) }); }
		});
	}
	d.addEventListener('scroll', followSelection, true);
	window.addEventListener('resize', followSelection);

	// Inline text editing ---------------------------------------------------
	var editingEl = null, editingOrig = '', lastEdited = null, lastOrig = null;
	// Whether the open edit has already been sent to the parent mid-way (the save key below). It is
	// what tells 'cancelEdit' that the source holds this text now, so abandoning the edit has to put
	// the original back there as well.
	var editReported = false;
	function startEdit(el, clientX, clientY) {
		if (editingEl) { commitEdit(); }
		if (!isEditableOrEmpty(el)) { post('not-editable', {}); return; }
		if (selEl && selEl !== el) { clearOutline(selEl); }
		selEl = el;
		editingEl = el;
		editingOrig = el.textContent || '';
		editReported = false;
		// Remember the current scroll BEFORE contenteditable focus: browsers may
		// auto-scroll to bring the caret into view and yank the page around.
		var y0 = scrollY();
		// Normalize: drop leftover marker nodes (<br>) from a previously cleared
		// element so contenteditable starts from a single clean text node.
		el.textContent = editingOrig;
		// Remember where the user double-clicked (before the element becomes
		// editable) so we can place the caret there instead of selecting all.
		var caretRange = null;
		if (typeof clientX === 'number' && d.caretRangeFromPoint) {
			try { caretRange = d.caretRangeFromPoint(clientX, clientY); } catch (err) { caretRange = null; }
		}
		el.setAttribute('contenteditable', 'plaintext-only');
		if (el.contentEditable !== 'plaintext-only') { el.setAttribute('contenteditable', 'true'); }
		el.focus();

		var sel = window.getSelection();
		sel.removeAllRanges();
		var r = null;
		if (caretRange && el.contains(caretRange.startContainer)) {
			r = caretRange;
			r.collapse(true); // caret only — no selection
		} else {
			// Fallback: put the caret at the end of the text.
			r = d.createRange();
			r.selectNodeContents(el);
			r.collapse(false);
		}
		sel.addRange(r);

		applyOutline(el, EDIT_COLOR, 2);
		postSelection(null);
		post('editing', { path: pathOf(el) });
		// Entering contenteditable can make the browser scroll the caret into
		// view; put the viewport back where the user was a moment later.
		(function (orig) {
			setTimeout(function () {
				try {
					if (Math.abs(scrollY() - orig) > 1) {
						setScrollY(orig);
					}
				} catch (e) { /* ignore */ }
			}, 80);
		})(y0);
	}
	function cancelEdit() {
		if (!editingEl) { return; }
		var el = editingEl;
		editingEl = null;
		el.removeAttribute('contenteditable');
		if ((el.textContent || '') !== editingOrig) { el.textContent = editingOrig; }
		// The edit was already sent up mid-way, so the source holds that text and the original has to
		// go back there too: abandoning an edit may not leave the file disagreeing with the page.
		if (editReported) { post('text-committed', { path: pathOf(el), text: editingOrig }); }
		editReported = false;
		if (selEl && selEl !== el) { clearOutline(selEl); }
		selEl = el;
		applyOutline(el, SEL_COLOR, 2);
	}
	function commitEdit() {
		if (!editingEl) { return; }
		var el = editingEl;
		editingEl = null;
		editReported = false;
		el.removeAttribute('contenteditable');
		lastEdited = el;
		lastOrig = editingOrig;
		editingOrig = '';
		var text = el.textContent || '';

		// Clearing the text means "delete this element": no empty ghost boxes.
		// Only when the element actually HAD content before (the user emptied it),
		// otherwise double-clicking an already-empty element is a no-op.
		if (text.trim() === '') {
			if ((lastOrig || '').trim() !== '') {
				removeElement(el);
				return;
			}
			applyOutline(el, SEL_COLOR, 2);
			postSelection(null);
			return;
		}

		// Keep the DOM identical to what gets written back to the source — this
		// also drops any <br> a browser may leave behind after clearing the text.
		el.textContent = text;
		applyOutline(el, SEL_COLOR, 2);
		post('text-committed', { path: pathOf(el), text: text });
		postSelection(null); // refresh selection box / format bar after the edit
	}

	var removedInfo = null;
	function removeElement(el) {
		var path = pathOf(el);
		if (!path || !el.parentNode) {
			// Can't delete — restore the previous text instead.
			el.textContent = lastOrig;
			selEl = el;
			applyOutline(el, SEL_COLOR, 2);
			return;
		}
		removedInfo = { el: el, parent: el.parentNode, next: el.nextSibling };
		if (hoverEl === el) { hoverEl = null; }
		if (selEl === el) { selEl = null; }
		el.parentNode.removeChild(el);
		post('element-removed', { path: path });
	}

	d.addEventListener('pointerover', function (e) {
		var t = e.target;
		if (!isIgnored(t)) { setHover(t); }
	}, true);
	d.addEventListener('pointerout', function (e) {
		if (hoverEl && e.target === hoverEl && (!e.relatedTarget || !hoverEl.contains(e.relatedTarget))) { clearHover(); }
	}, true);
	d.addEventListener('click', function (e) {
		if (editingEl && editingEl.contains(e.target)) { return; }
		var t = e.target;
		if (isIgnored(t)) {
			// Clicking blank/unselectable area deselects the current element.
			e.preventDefault();
			e.stopPropagation();
			clearSelection();
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		setSelect(t);
	}, true);
	d.addEventListener('dblclick', function (e) {
		var t = e.target;
		if (isIgnored(t)) { return; }
		e.preventDefault();
		e.stopPropagation();
		if (editingEl && editingEl.contains(t)) { return; }
		startEdit(t, e.clientX, e.clientY);
	}, true);

	// Browsers select a word during the SECOND mouse press of a double-click,
	// before the dblclick event even fires — that causes a visible "select then
	// collapse" flash. Suppress the native selection on that second press; real
	// selection inside an already-editing element is still allowed.
	var lastDownAt = 0;
	var lastDownEl = null;
	d.addEventListener('mousedown', function (e) {
		var t = e.target;
		if (editingEl && editingEl.contains(t)) { lastDownEl = null; return; }
		var now = Date.now();
		if (t === lastDownEl && (now - lastDownAt) < 400) {
			e.preventDefault();
			e.stopPropagation();
			lastDownAt = 0;
		} else {
			lastDownAt = now;
			lastDownEl = t;
		}
	}, true);
	d.addEventListener('keydown', function (e) {
		// Ctrl/Cmd + S: the parent owns the file, so it does the writing. A key pressed in here
		// belongs to this document and reaches no listener outside it, so it is forwarded.
		// Text being edited is sent up **as it stands, without ending the edit**: saving is no reason
		// to take the caret out of what somebody is typing in, and the parent patches the source and
		// writes it. 'editReported' is what keeps an Escape afterwards from disagreeing with the file.
		if ((e.ctrlKey || e.metaKey) && (e.key || '').toLowerCase() === 's') {
			e.preventDefault();
			e.stopPropagation();
			if (editingEl) {
				editReported = true;
				post('text-committed', { path: pathOf(editingEl), text: editingEl.textContent || '' });
			}
			post('save', {});
			return;
		}
		if (editingEl) {
			if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
			else if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
			return;
		}
		// Deleting a selected (non-editing) element with Backspace / Delete.
		var t = e.target;
		if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) { return; }
		// Undo / redo shortcuts (Ctrl/⌘ + Z / Shift+Z / Y). The parent owns the
		// history, so these are forwarded rather than handled here.
		if (e.ctrlKey || e.metaKey) {
			var key = (e.key || '').toLowerCase();
			if (key === 'z' || key === 'y') {
				e.preventDefault();
				e.stopPropagation();
				post((key === 'y' && !e.shiftKey) || (key === 'z' && e.shiftKey) ? 'redo' : 'undo', {});
				return;
			}
		}
		if (selEl && (e.key === 'Backspace' || e.key === 'Delete')) {
			e.preventDefault();
			e.stopPropagation();
			removeElement(selEl);
		} else if (selEl && e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			clearSelection();
		}
	}, true);
	d.addEventListener('focusout', function (e) {
		if (editingEl && e.target === editingEl) { commitEdit(); }
	}, true);
	d.addEventListener('paste', function (e) {
		if (!editingEl) { return; }
		e.preventDefault();
		e.stopPropagation();
		var text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
		if (text) { try { d.execCommand('insertText', false, text); } catch (err) { } }
	}, true);

	// Parent → frame (style commands, and reverting a source patch that failed).
	//
	// The selection/hover box is drawn with CSSOM outline props, which the
	// browser serializes into the element's style attribute. Before sending that
	// attribute back to the parent we must strip those transient props, otherwise
	// the "selected" box would be written into the source as a real outline.
	function cleanStyleAttr() {
		var s = selEl.style;
		var keepOutline = s.outline;
		var keepOutlineOffset = s.outlineOffset;
		s.outline = '';
		s.outlineOffset = '';
		var v = selEl.getAttribute('style') || '';
		s.outline = keepOutline;
		s.outlineOffset = keepOutlineOffset;
		return v;
	}
	var lastStyleAttr = null;
	window.addEventListener('message', function (e) {
		var m = e.data;
		if (!m || m.__craftHtmlEdit !== TOKEN) { return; }
		if (m.action === 'revert-text' && lastEdited && lastOrig !== null) {
			if ((lastEdited.textContent || '') !== lastOrig) { lastEdited.textContent = lastOrig; }
			lastEdited = null;
			lastOrig = null;
		} else if (m.action === 'clear-select') {
			// Esc pressed while focus was on the parent toolbar / input row.
			clearSelection();
		} else if (m.action === 'report-scroll') {
			// The parent cannot read our scroll position (opaque origin), so it
			// asks us before reloading the document for undo/redo.
			var sy = scrollY();
			var max = docHeight() - (d.defaultView.innerHeight || 0);
			var frac = max > 0 ? Math.min(1, Math.max(0, sy / max)) : 0;
			post('scroll-report', { frac: frac });
		} else if (m.action === 'remove-selection' && selEl) {
			// Asked for by the toolbar, which has no other way to reach the document.
			removeElement(selEl);
		} else if (m.action === 'restore-element' && removedInfo) {
			var ri = removedInfo;
			removedInfo = null;
			if (ri.next && ri.next.parentNode === ri.parent) { ri.parent.insertBefore(ri.el, ri.next); }
			else if (ri.parent) { ri.parent.appendChild(ri.el); }
			selEl = ri.el;
			applyOutline(selEl, SEL_COLOR, 2);
			postSelection(null);
		} else if (m.action === 'style' && selEl && selEl.style) {
			lastStyleAttr = cleanStyleAttr();
			var st = selEl.style;
			if (m.op === 'bold') {
				// Toggle against the EFFECTIVE state (computed), and unbold by
				// writing "normal" — removing the inline style would leave
				// headings / <strong> / inherited bold still looking bold.
				var csB = typeof getComputedStyle === 'function' ? getComputedStyle(selEl).fontWeight : '';
				var effBold = selEl.style.fontWeight === 'bold' || csB === 'bold' || (parseFloat(csB) >= 600);
				st.fontWeight = effBold ? 'normal' : 'bold';
			} else if (m.op === 'italic') {
				var csI = typeof getComputedStyle === 'function' ? getComputedStyle(selEl).fontStyle : '';
				var effItalic = selEl.style.fontStyle === 'italic' || csI === 'italic';
				st.fontStyle = effItalic ? 'normal' : 'italic';
			} else if (m.op === 'underline' || m.op === 'strike') {
				var name = m.op === 'underline' ? 'underline' : 'line-through';
				var toks = decorList(selEl);
				var idx = toks.indexOf(name);
				if (idx !== -1) { toks.splice(idx, 1); } else { toks.push(name); }
				writeDeco(selEl, toks);
			} else if (m.op === 'fontSize') {
				var base = parseFloat(st.fontSize);
				if (!isFinite(base) || !base) { base = parseFloat(getComputedStyle(selEl).fontSize); }
				if (!isFinite(base) || !base) { base = 14; }
				base += m.value === '-' ? -2 : 2;
				base = Math.max(8, Math.min(72, Math.round(base)));
				st.fontSize = base + 'px';
			} else if (m.op === 'color') {
				st.color = m.value || '';
			}
			post('style-applied', {
				path: pathOf(selEl),
				attrStyle: cleanStyleAttr(),
				// A style can resize the box the controls are anchored to — a font size does.
				rect: rectOf(selEl),
				style: styleState(selEl)
			});
		} else if (m.action === 'revert-style' && selEl) {
			if (lastStyleAttr) { selEl.setAttribute('style', lastStyleAttr); }
			else { selEl.removeAttribute('style'); }
			lastStyleAttr = null;
			// Restore the selection box after the attribute was overwritten.
			applyOutline(selEl, SEL_COLOR, 2);
			post('style-reverted', {
				path: pathOf(selEl),
				attrStyle: cleanStyleAttr(),
				rect: rectOf(selEl),
				style: styleState(selEl)
			});
		}
	});

	// The page may scroll on <html> (default) or on <body> when the source CSS
	// turns body into its own scroll container — read/restore both.
	function scrollY() {
		var w = d.defaultView;
		var p = w ? w.pageYOffset : 0;
		if (p > 0) { return p; }
		if (d.documentElement && d.documentElement.scrollTop > 0) { return d.documentElement.scrollTop; }
		if (d.body && d.body.scrollTop > 0) { return d.body.scrollTop; }
		return p;
	}
	function docHeight() {
		return Math.max(
			d.documentElement ? d.documentElement.scrollHeight : 0,
			d.body ? d.body.scrollHeight : 0
		);
	}
	function setScrollY(y) {
		try { d.defaultView.scrollTo(0, y); } catch (err) { /* ignore */ }
		try { if (d.documentElement) { d.documentElement.scrollTop = y; } } catch (err) { /* ignore */ }
		try { if (d.body) { d.body.scrollTop = y; } } catch (err) { /* ignore */ }
	}
	function restoreScroll() {
		var byPixel = RESTORE_SCROLL_PX > 0;
		if (!byPixel && !(RESTORE_SCROLL > 0)) { return; }
		try {
			var max = docHeight() - (d.defaultView.innerHeight || 0);
			var limit = max > 0 ? max : 0;
			// A pixel offset is where the *preview* was scrolled to: the same page in the same box,
			// so the same number is the same place — which is why the editor is handed one rather
			// than a fraction. A fraction is for a rebuild, where the document itself has changed
			// by an edit and the place worth keeping is the relative one.
			var target = byPixel
				? Math.max(0, Math.min(limit, Math.round(RESTORE_SCROLL_PX)))
				: Math.max(0, Math.min(limit, Math.round(RESTORE_SCROLL * limit)));
			var cur = scrollY();
			// Never fight the user: if they scrolled somewhere else while the
			// new document was loading, leave the viewport alone.
			if (cur > 2 && Math.abs(cur - target) > 4) { return; }
			if (Math.abs(cur - target) <= 1) { return; }
			setScrollY(target);
		} catch (e) { /* ignore */ }
	}
	restoreScroll();
	if (d.defaultView.addEventListener) {
		d.defaultView.addEventListener('load', restoreScroll);
	}
	if (d.fonts && d.fonts.ready && typeof d.fonts.ready.then === 'function') {
		try { d.fonts.ready.then(function () { setTimeout(restoreScroll, 0); }); } catch (err) { /* ignore */ }
	}
	// Layout keeps settling (images / webfonts) after the first attempt — retry
	// a few more times in case the initial restore happened too early or got
	// lost at the top of the document.
	setTimeout(restoreScroll, 250);
	setTimeout(restoreScroll, 700);
	setTimeout(restoreScroll, 1500);

	post('ready', {});
	}
	if (d.body) { boot(); }
	else if (d.readyState === 'loading') { d.addEventListener('DOMContentLoaded', boot); }
	else { setTimeout(boot, 0); }
})();`

/** Where to put the viewport when the document opens. Both halves are optional and one of them
 *  wins: `px` if given, otherwise `frac`. See the probe's `restoreScroll` for why there are two. */
export interface RestoreScroll {
  /** A 0..1 fraction of what there is to scroll — for a rebuild, where the document has changed. */
  frac?: number
  /** A pixel offset — for the first draw, where it comes from the preview the person was reading. */
  px?: number
}

/**
 * Wrap raw HTML with the editing probe script. `token` is the random per-instance
 * value shared with the parent window.
 *
 * Injection placement matters: the probe is a real `<script>` node, and the parent
 * maps frame elements to the raw source by *element-child indices*. Any node added
 * as a body child would shift those indices. To keep the body subtree structurally
 * identical to `parse5.parse(source)`:
 *   - documents with a `<head>` → insert right after the `<head>` tag (head child);
 *   - documents with a `<body>` but no `<head>` → insert before `<body>`, which the
 *     HTML parser hoists into the auto-created `<head>`;
 *   - bare fragments → append at the end (probe becomes the last body child).
 */
export function buildDesignDoc(html: string, token: string, scroll: RestoreScroll = {}): string {
  const frac = finite(scroll.frac)
  const px = finite(scroll.px)
  const script = DESIGN_SCRIPT.replace('__TOKEN__', token)
    .replace('__RESTORE_SCROLL_PX__', String(px))
    .replace('__RESTORE_SCROLL__', String(frac))
  const tag = '<script>' + script + '</' + 'script>'

  const headMatch = html.match(/<head(?:\s[^>]*)?>/i)
  if (headMatch && headMatch.index !== undefined) {
    const insertAt = headMatch.index + headMatch[0].length
    return html.slice(0, insertAt) + tag + html.slice(insertAt)
  }

  const bodyMatch = html.match(/<body(?:\s[^>]*)?>/i)
  if (bodyMatch && bodyMatch.index !== undefined) {
    return html.slice(0, bodyMatch.index) + tag + html.slice(bodyMatch.index)
  }

  return html + tag
}

/** A positive finite number, or 0 — the probe tests these with `> 0`. */
function finite(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}
