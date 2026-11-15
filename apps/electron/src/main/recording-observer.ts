/**
 * What the page reports while it is being recorded.
 *
 * Clicks and fills cannot be seen from the host. Electron tells it when a tab navigates and when
 * a request finishes, but "somebody pressed *Export*" is only knowable from inside the document —
 * so a recording puts a small script in the page for as long as it covers that tab, and the page
 * says what was done to it.
 *
 * ## How the page gets a word out
 *
 * A prefixed `console.log`, which the pane manager already listens for and recognises — the same
 * door the theme-colour observer uses (`THEME_COLOR_SIGNAL_PREFIX`). The prefix is what makes the
 * message **not** land in the tab's console log: it is a signal, not something the page said.
 * Nothing is buffered, so nothing is lost when a click navigates the document away — the report
 * leaves the page at the moment the action happens.
 *
 * ## Only what a person did
 *
 * Every listener checks `isTrusted`, which is the browser's own answer to "did a human do this" —
 * a script calling `button.click()` is not a step somebody took, and a recording of a page that
 * polls itself would otherwise fill with actions nobody performed.
 *
 * ## What a value is kept for
 *
 * A `fill` carries what was typed, so a step can say what was searched for rather than only that
 * the search box was used. It is an **allowlist read off the field's own declaration**: the input
 * kinds whose purpose is text a person typed, and never a value from a field that calls itself a
 * credential — `type=password`, or an `autocomplete` naming one. A field kind nobody thought about
 * records its name alone, which is the safe way round for a file that lands beside a film.
 *
 * ## Two halves, because a recording is about now
 *
 * The registration is an **init script**, which reaches documents that do not exist yet — and a
 * second injection into the document in front of the person, who is about to demonstrate
 * something in *that* one. Removing it is the same pair in reverse, and the copy already in a
 * document is silenced rather than abandoned: a listener still reporting to nobody is still a
 * listener in somebody's page.
 */

import type { ElementRef, RecordingEvent } from './recording-sidecar.ts'

/** Marks a console message as this feature's own, so it is a signal rather than page output. */
export const RECORDING_SIGNAL_PREFIX = '__craft_recording__:'

/** The key the init script is registered under, so exactly this feature can take it back. */
export const RECORDING_OBSERVER_KEY = 'recording:observer'

/** The longest value written down, at either end. */
const VALUE_MAX = 200

/**
 * The page's half. One IIFE, safe to run twice (an init script and an injection both land in the
 * same document), and it hands back an `off()` so a document that is still open can be silenced.
 *
 * The `ElementRef` it builds is deliberately coarse — tag, role, name — and **not** a CSS
 * selector: the two must agree with what a playbook declares, and that vocabulary is still being
 * settled (`docs/playbooks-plan.md` §5.2④). Recording the coarse one now is honest; inventing a
 * selector grammar the reader would later have to translate is not.
 */
export function buildRecordingObserverSource(): string {
  return `(() => {
  var existing = window.__craftRecordingObserver;
  if (existing && typeof existing.off === 'function') return;
  var PREFIX = ${JSON.stringify(RECORDING_SIGNAL_PREFIX)};
  var NAME_MAX = 120;
  var ROLE_BY_TAG = { A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', SUMMARY: 'button' };
  var ACTIONABLE = 'a,button,input,select,textarea,summary,[role]';

  // What was typed is worth keeping, for the field kinds whose whole purpose is text a person
  // typed. The list is an allowlist on purpose: a field kind nobody thought about records its
  // name and nothing else, which is the safe way round for a file that lands in a folder people
  // hand to each other.
  var TEXT_INPUT_TYPES = {
    text: 1, search: 1, url: 1, email: 1, tel: 1, number: 1,
    date: 1, 'datetime-local': 1, month: 1, week: 1, time: 1,
  };
  // And what the field itself says about the value: a credential is never recorded, whatever its
  // type. Read from the field's own declaration rather than guessed from its label.
  var SECRET_AUTOCOMPLETE = /password|one-time-code|cc-/i;
  var VALUE_MAX = 200;

  var text = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();

  var readValue = (el) => {
    if (typeof el.value !== 'string') return null;
    return el.value.length > VALUE_MAX ? el.value.slice(0, VALUE_MAX) : el.value;
  };

  var valueOf = (el) => {
    var tag = el.tagName.toLowerCase();
    if (tag === 'select' || tag === 'textarea') return readValue(el);
    var type = (el.getAttribute('type') || 'text').toLowerCase();
    if (!TEXT_INPUT_TYPES[type]) return null;
    if (SECRET_AUTOCOMPLETE.test(el.getAttribute('autocomplete') || '')) return null;
    return readValue(el);
  };

  var nameOf = (el) => {
    var carried = el.getAttribute('aria-label') || el.getAttribute('placeholder') ||
      el.getAttribute('title') || el.getAttribute('alt');
    if (carried) return text(carried).slice(0, NAME_MAX);

    // A field's value is a **different fact**, and it is recorded as one (see valueOf below).
    // Reading it here as well would make a field's name change to whatever was last typed into
    // it — measured, and wrong: a textarea's name came back as the sentence written in it.
    // A button is the exception: its caption really is its value.
    var tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      var inputType = (el.getAttribute('type') || 'text').toLowerCase();
      return /^(submit|button|reset)$/.test(inputType)
        ? text(el.value).slice(0, NAME_MAX)
        : text(el.getAttribute('name') || '').slice(0, NAME_MAX);
    }
    if (tag === 'textarea' || tag === 'select') {
      return text(el.getAttribute('name') || '').slice(0, NAME_MAX);
    }

    return text(el.innerText || el.getAttribute('name') || '').slice(0, NAME_MAX);
  };

  var roleOf = (el) => {
    var explicit = el.getAttribute('role');
    if (explicit) return text(explicit);
    // Before the tag table, because an input element is several things: a text box, a checkbox, or
    // the button that submits the form — and only its own type says which.
    if (el.tagName === 'INPUT') {
      var inputType = (el.getAttribute('type') || 'text').toLowerCase();
      if (inputType === 'checkbox') return 'checkbox';
      if (inputType === 'radio') return 'radio';
      if (inputType === 'submit' || inputType === 'button' || inputType === 'reset') return 'button';
      return 'textbox';
    }
    var byTag = ROLE_BY_TAG[el.tagName];
    if (byTag) return byTag;
    return el.tagName.toLowerCase();
  };

  var describe = (el) => ({ tag: el.tagName.toLowerCase(), role: roleOf(el), name: nameOf(el) });

  var send = (event) => {
    try { console.log(PREFIX + JSON.stringify(event)); } catch (ignored) {}
  };

  var onClick = (event) => {
    if (event.isTrusted !== true) return;
    var target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    send({ type: 'click', target: describe(target.closest(ACTIONABLE) || target) });
  };

  var onChange = (event) => {
    if (event.isTrusted !== true) return;
    var target = event.target;
    if (!target || !target.tagName) return;
    var tag = target.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return;
    var reported = { type: 'fill', target: describe(target) };
    var value = valueOf(target);
    // Absent rather than empty: "this field said nothing about its value" and "it was cleared" are
    // different facts, and only one of them is worth writing down.
    if (value !== null) reported.value = value;
    send(reported);
  };

  document.addEventListener('click', onClick, true);
  document.addEventListener('change', onChange, true);

  window.__craftRecordingObserver = {
    off: () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('change', onChange, true);
      window.__craftRecordingObserver = null;
    },
  };
})();`
}

/** Silences the observer in a document that already has one — the half an init script cannot reach. */
export function buildRecordingObserverOffSource(): string {
  return '(() => { var o = window.__craftRecordingObserver; if (o && typeof o.off === "function") o.off(); })();'
}

/**
 * Read one of the page's messages, or `null` when it is not one of ours (or not readable).
 *
 * Anything malformed is dropped: this sits on the path of every console message a page ever
 * prints, and a page that prints the prefix by accident must not take the browser down.
 */
export function parseRecordingSignal(message: string): RecordingEvent | null {
  if (!message.startsWith(RECORDING_SIGNAL_PREFIX)) return null

  try {
    const parsed: unknown = JSON.parse(message.slice(RECORDING_SIGNAL_PREFIX.length))
    if (!parsed || typeof parsed !== 'object') return null

    const candidate = parsed as Partial<RecordingEvent> & { target?: Partial<ElementRef> }
    const target = candidate.target
    if (!target || typeof target.tag !== 'string') return null

    const ref: ElementRef = {
      tag: target.tag,
      role: typeof target.role === 'string' ? target.role : target.tag,
      name: typeof target.name === 'string' ? target.name : '',
    }

    if (candidate.type === 'click') return { type: 'click', target: ref }
    if (candidate.type === 'fill') {
      // The page caps what it sends, but a page is not a party anybody has to trust: cap it here
      // too, where the file is written.
      return typeof candidate.value === 'string'
        ? { type: 'fill', target: ref, value: candidate.value.slice(0, VALUE_MAX) }
        : { type: 'fill', target: ref }
    }
    return null
  } catch {
    return null
  }
}
