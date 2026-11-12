/**
 * compose-event-handlers.ts — run a caller's event handler and a control's
 * own handler of the same name, so neither replaces the other.
 *
 * A primitive spreads the caller's remaining props onto its root element. A
 * handler the control needs (arrow-key roving, the copy menu, the editing
 * lifecycle) written before that spread is silently replaced by a caller's
 * handler of the same name. So the control destructures the handler name out
 * of its props and writes the composed handler after `{...rest}`.
 *
 * The caller's handler runs first. The control's runs unless the caller called
 * `preventDefault()`: a caller can still veto the control's behaviour, but
 * only as an explicit act, never as an accident of prop order.
 */

/** The part of an event the composition reads. */
interface PreventableEvent {
  readonly defaultPrevented: boolean;
}

/**
 * Compose a caller's handler with the control's own. Either may be absent;
 * the result is always a function, so it can be written unconditionally.
 */
export function composeEventHandlers<E extends PreventableEvent>(
  callerHandler: ((event: E) => void) | undefined,
  ownHandler: ((event: E) => void) | undefined,
): (event: E) => void {
  return (event: E) => {
    callerHandler?.(event);
    if (!event.defaultPrevented) {
      ownHandler?.(event);
    }
  };
}
