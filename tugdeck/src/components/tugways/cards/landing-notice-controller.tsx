/**
 * LandingNoticeController — projects a landing mode's failures onto a pane
 * bulletin ([L31]).
 *
 * Two things can go wrong with a landing and neither used to have a surface for
 * join. A `changeset_commit_err` / `changeset_join_err` reply settles into
 * `landError` and re-enters the mode, so the shade flashes and comes back with
 * no word of why; and a refused press published nothing at all, which is the
 * failure mode that made the dead Join button unreproducible for days. This
 * controller speaks both, for whichever landing mode it is handed — generalized
 * over {@link LandingMode} rather than copied per kind, so a landing surface
 * cannot be added without its voice.
 *
 * Zero render: it subscribes straight to the controller ([L22] — a bulletin is
 * a direct DOM update and must not round-trip through
 * `useSyncExternalStore`/render), registers in `useLayoutEffect` ([L03]), keeps
 * its posted record in a ref ([L24]), and puts nothing in React state ([L02]).
 * What to post is `landingNoticeDecision`'s to say; this file only applies it.
 */

import { useLayoutEffect, useRef } from "react";

import type { LandingMode } from "@/lib/landing-mode";
import {
  NO_LANDING_NOTICE,
  landingNoticeDecision,
  type LandingNoticeState,
} from "@/lib/landing-notice";

import { useTugPaneBulletin } from "../tug-pane-bulletin";

export function LandingNoticeController({ controller }: { controller: LandingMode }): null {
  const api = useTugPaneBulletin();
  // What is on screen right now. Local data ([L24]) — never React state.
  const postedRef = useRef<LandingNoticeState>(NO_LANDING_NOTICE);

  useLayoutEffect(() => {
    const apply = (): void => {
      const { actions, next } = landingNoticeDecision(
        controller.kind,
        postedRef.current,
        controller.getSnapshot(),
      );
      postedRef.current = next;
      for (const action of actions) {
        if (action.kind === "dismiss") {
          api.dismiss(action.id);
        } else if (action.tone === "danger") {
          api.danger(action.title, {
            id: action.id,
            description: action.description,
            sticky: true,
          });
        } else {
          api.caution(action.title, { id: action.id, description: action.description });
        }
      }
    };

    apply();
    return controller.subscribe(apply);
  }, [controller, api]);

  return null;
}
