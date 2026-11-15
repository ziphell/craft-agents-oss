/**
 * The two ways a previewed page can be shown, as the sandbox each one needs.
 *
 * **A page with an address** (`file://`, its own file) runs its own scripts and its relative
 * references resolve against its folder. **A page drawn from text** (`srcDoc`, the fallback for a
 * host that cannot hand a file an address) has none of that: no scripts, nothing to resolve.
 *
 * The one thing a previewed page must never do is reach the app, and `allow-same-origin` is what
 * decides that. A frame with **both** it and `allow-scripts` can reach its parent and unset its own
 * sandbox, so the sandbox stops being one — hence the split: scripts *or* same-origin, never both.
 */

/**
 * A page with an address: scripts run, and its origin is **opaque**.
 *
 * What the page gives up for it is access to the app's DOM and storage — not to its own folder,
 * whose files it loads as ordinary subresources, and not to the canvas it draws on.
 *
 * `allow-top-navigation-by-user-activation` is there for links: a click may navigate the top frame,
 * where the app's navigation policy answers it (a browser) rather than trapping the person inside
 * the preview.
 */
export const SERVED_PAGE_SANDBOX = 'allow-scripts allow-forms allow-top-navigation-by-user-activation'

/**
 * A page drawn from text: no address, so nothing to run and nothing to resolve.
 *
 * `allow-same-origin` is kept here because the frame *is* the app's origin and there is no script to
 * abuse it with — the pair is what the old preview always was.
 */
export const DRAWN_PAGE_SANDBOX = 'allow-same-origin allow-top-navigation-by-user-activation'
