"use client";

import { Move, SlidersHorizontal } from "lucide-react";
import { useMemo, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import { retronow } from "./retronow-classes";

type DeckCard = {
  id: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

const SNAP = 24;

function snap(value: number) {
  return Math.round(value / SNAP) * SNAP;
}

export function RetronowDeckCanvas() {
  const [cards, setCards] = useState<DeckCard[]>([
    { id: "navigator", title: "Navigator", x: 24, y: 24, w: 520, h: 340 },
    { id: "telemetry", title: "Telemetry", x: 576, y: 24, w: 360, h: 220 },
    { id: "controls", title: "Deck Controls", x: 576, y: 264, w: 300, h: 180 }
  ]);

  const [dragMeta, setDragMeta] = useState<{ id: string; startX: number; startY: number } | null>(null);

  const preview = useMemo(() => {
    if (!dragMeta) return null;
    const card = cards.find((c) => c.id === dragMeta.id);
    return card ?? null;
  }, [cards, dragMeta]);

  function beginPointer(event: ReactPointerEvent, id: string) {
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragMeta({ id, startX: event.clientX, startY: event.clientY });
  }

  function onPointerMove(event: ReactPointerEvent, id: string) {
    if (!dragMeta || dragMeta.id !== id) return;

    const dx = event.clientX - dragMeta.startX;
    const dy = event.clientY - dragMeta.startY;

    setCards((prev) =>
      prev.map((card) => {
        if (card.id !== id) return card;

        return {
          ...card,
          x: snap(card.x + dx),
          y: snap(card.y + dy)
        };
      })
    );

    setDragMeta({ ...dragMeta, startX: event.clientX, startY: event.clientY });
  }

  function endPointer(event: ReactPointerEvent) {
    if (!dragMeta) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setDragMeta(null);
  }

  return (
    <section className={retronow.cardCanvas}>
      <div className="flex items-center gap-2 border-b border-[#8e8878] bg-[linear-gradient(180deg,#6a7780_0%,#5a6770_100%)] p-2">
        <button className={retronow.button}>New Card</button>
        <button className={retronow.buttonSecondary}>Layout Preset</button>
        <span className="rounded-[3px] border border-[#8e8878] bg-[#dbe2e8] px-2 py-1 font-mono text-xs uppercase">
          Snap {SNAP}px Grid
        </span>
      </div>

      <div className="relative min-h-[calc(70vh-58px)] p-4">
        {cards.map((card) => (
          <article
            key={card.id}
            className={retronow.card}
            style={{ left: card.x, top: card.y, width: card.w, height: card.h }}
            onPointerMove={(e) => onPointerMove(e, card.id)}
            onPointerUp={endPointer}
            onPointerCancel={endPointer}
          >
            <header className={retronow.cardHeader} onPointerDown={(e) => beginPointer(e, card.id)}>
              <span>{card.title}</span>
              {card.id === "controls" ? <SlidersHorizontal className="h-4 w-4" /> : <Move className="h-4 w-4" />}
            </header>
            <div className={retronow.cardBody}>
              <div className="grid grid-cols-2 gap-2">
                <div className="min-h-16 rounded-[3px] border border-[#8e8878] bg-[#dde4e7]" />
                <div className="min-h-16 rounded-[3px] border border-[#8e8878] bg-[#dde4e7]" />
                <div className="min-h-16 rounded-[3px] border border-[#8e8878] bg-[#dde4e7]" />
                <div className="min-h-16 rounded-[3px] border border-[#8e8878] bg-[#dde4e7]" />
              </div>
            </div>
          </article>
        ))}

        {preview && (
          <div
            className="pointer-events-none absolute rounded-[5px] border border-dashed border-[#f4df9f] bg-[#f4df9f]/12"
            style={{ left: preview.x, top: preview.y, width: preview.w, height: preview.h }}
          />
        )}
      </div>
    </section>
  );
}
