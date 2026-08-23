/**
 * DashJoinRegister — one dash's join arc, wearing the transcript's own chrome.
 *
 * The register says what is happening between a dash reaching `built` and its
 * join landing: reconciling, checking, ready, waiting on a decision, red,
 * joining. It mounts on three surfaces — the Lens Dashes row, the Changes
 * shade's dash row, and the transcript's live edge — and the whole point is
 * that all three read the *same sentence*, because all three call the same
 * pure derivation ({@link dashJoinRegister}).
 *
 * **It composes `BlockHeader` rather than inventing a status chrome.** The
 * transcript already taught this row: a lifecycle dot that pulses for work in
 * flight, pulses caution while a person is being waited on, and settles green
 * or red on a verdict. A second status vocabulary for the same kind of fact is
 * how two surfaces come to disagree; reusing this one means they cannot.
 *
 * **Status, never a control.** Nothing here is pressable. Every act in the
 * join arc lives in Z5 or in the prompt — a register that offered a button
 * would be the shade's thicket rebuilt one surface over.
 *
 * Laws: [L02] every value arrives as a prop from the caller's own store read —
 * this file reads no store; [L06] tone and motion paint through the dot's own
 * `data-phase`, never React state; [L13] the pulse is
 * `TugProgressIndicator`'s, not a `requestAnimationFrame` here; [L19] `.tsx` /
 * `.css` pair, docstring, `data-slot`; [L20] the CSS frames and positions the
 * header and **never** reaches into its `--tugx-toolheader-*` family, which is
 * the header's to own.
 *
 * @tug-pairings BlockHeader
 *
 * @module components/tugways/dash-join-register
 */

import "./dash-join-register.css";

import React from "react";

import { BlockHeader } from "./blocks/block-header";
import type { BlockAltitude } from "./blocks/block-strip";
import {
  dashJoinRegister,
  type DashJoinRegisterInput,
} from "@/lib/dash-join-register";

export interface DashJoinRegisterProps extends DashJoinRegisterInput {
  /**
   * Altitude tier forwarded to the header. `leaf` (the default) is the
   * transcript's own metrics; a Lens band or a card row passes its own.
   */
  altitude?: BlockAltitude;
  /** Forwarded class name. */
  className?: string;
}

/**
 * The register, or nothing at all.
 *
 * Returns `null` when the derivation has nothing to report — a dash still
 * being worked has no join arc yet, and a register that mounted empty would be
 * a row of chrome saying nothing.
 */
export function DashJoinRegister({
  altitude,
  className,
  ...input
}: DashJoinRegisterProps): React.ReactElement | null {
  return (
    <DashJoinRegisterView
      register={dashJoinRegister(input)}
      {...(altitude !== undefined ? { altitude } : {})}
      {...(className !== undefined ? { className } : {})}
    />
  );
}

/**
 * The register's chrome, over an already-derived reading.
 *
 * For the caller that has run the derivation somewhere else — the composer
 * reads its register off the landing snapshot, because the snapshot is the one
 * slot the entry drives both landing modes through and the entry must stay
 * ignorant of which landing it is hosting. Same chrome, same `data-slot`, so
 * the composer's register and the shade's are the same element.
 */
export function DashJoinRegisterView({
  register,
  altitude,
  className,
}: {
  register: ReturnType<typeof dashJoinRegister>;
  altitude?: BlockAltitude;
  className?: string;
}): React.ReactElement | null {
  if (register === null) return null;
  return (
    <div
      className={["tug-dash-join-register", className].filter(Boolean).join(" ")}
      data-slot="dash-join-register"
      data-word={register.word}
    >
      <BlockHeader
        phase={register.phase}
        target={register.line}
        summary={{ kind: "text", text: register.word }}
        {...(altitude !== undefined ? { altitude } : {})}
      />
    </div>
  );
}
