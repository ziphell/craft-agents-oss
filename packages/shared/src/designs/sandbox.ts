/**
 * The sandbox every design frame gets — the one place the rule lives.
 *
 * Designs are scripts + forms in an **opaque origin** and nothing else:
 * `allow-scripts` because a design is an app (a deck's navigation, a chart it
 * draws itself, a button that asks for a grant), `allow-forms` because a form
 * is a form, and never `allow-same-origin` because that is the whole guarantee
 * — the frame cannot see the app, its cookies or its DOM, and every capability
 * it uses has to cross the `craft-designs/v1` bridge where the host validates
 * it (nonce, grants, a real user gesture). Published copies add
 * `connect-src 'none'` on top, so a shared design reaches nothing at all.
 *
 * There is deliberately **no "no scripts" variant**. There used to be one: a
 * `static` design kind got the empty sandbox. It protected nothing — the party
 * declaring the kind is the party that authored the HTML — and its only
 * reliable effect was to kill a document that needed a script (a deck that
 * could not turn a page, a composition that never moved) silently, with no
 * error anywhere. If a page must run no code, that belongs to the host, not to
 * the content: an `html-preview` block is already scripts-off by construction.
 *
 * Both frames that render a design use this: the app's own renderer
 * (`DesignFrame`) and the hidden window that captures a poster or an export
 * (`design-thumbnail-host`) — so what you see, what the poster shows and what
 * an export contains are the same document under the same rule.
 */
export const DESIGN_FRAME_SANDBOX = 'allow-scripts allow-forms'
