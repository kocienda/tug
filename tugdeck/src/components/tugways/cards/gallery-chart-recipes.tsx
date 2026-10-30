/**
 * gallery-chart-recipes.tsx — Chart Recipes gallery card: one live example of
 * every well-known recipe, each run over the frontmost project.
 *
 * The list and the outcomes come from tugcast through `chart-recipes-store`
 * [L02]. A recipe with data draws through the one `ChartBlock`; one with none
 * shows its summary line in the figure's place. A section's state is an
 * attribute the card's CSS reads [L06].
 */

import React from "react";

import { ChartBlock } from "@/components/tugways/body-kinds/chart-block";
import { TugLabel } from "@/components/tugways/tug-label";
import { TugSeparator } from "@/components/tugways/tug-separator";
import { useChartRecipes, type RecipeOutcome } from "@/lib/chart-recipes-store";
import { useFrontmostProjectBinding } from "@/lib/frontmost-project";

import "./gallery-chart-recipes.css";

const STATE_OF: Record<RecipeOutcome["kind"], string> = {
  pending: "pending",
  chart: "chart",
  noData: "no-data",
  failed: "failed",
};

function Figure({ outcome }: { outcome: RecipeOutcome }): React.ReactElement {
  switch (outcome.kind) {
    case "pending":
      return <TugLabel className="gallery-chart-recipes-line" emphasis="calm">Running…</TugLabel>;
    case "chart":
      return <ChartBlock source={JSON.stringify(outcome.spec)} />;
    case "noData":
      return <TugLabel className="gallery-chart-recipes-line" emphasis="calm">{outcome.summary}</TugLabel>;
    case "failed":
      return <TugLabel className="gallery-chart-recipes-line" emphasis="calm">{`Could not read: ${outcome.message}`}</TugLabel>;
  }
}

export function GalleryChartRecipes(): React.ReactElement {
  const projectDir = useFrontmostProjectBinding()?.projectDir ?? null;
  const { rows, listFailure } = useChartRecipes(projectDir);

  let content: React.ReactNode;
  if (projectDir === null) {
    content = <TugLabel emphasis="calm">No project is open.</TugLabel>;
  } else if (listFailure !== null) {
    content = <TugLabel emphasis="calm">{`Could not read the recipes: ${listFailure}`}</TugLabel>;
  } else if (rows === null) {
    content = <TugLabel emphasis="calm">Reading the recipes…</TugLabel>;
  } else {
    content = rows.map((row, i) => (
      <React.Fragment key={row.name}>
        {i > 0 ? <TugSeparator /> : null}
        <div
          className="cg-section gallery-chart-recipes-section"
          data-tugx-recipe={row.name}
          data-tugx-recipe-state={STATE_OF[row.outcome.kind]}
        >
          <div className="gallery-chart-recipes-heading">
            <TugLabel className="cg-section-title">{row.name}</TugLabel>
            <TugLabel emphasis="calm">{row.question}</TugLabel>
          </div>
          <Figure outcome={row.outcome} />
        </div>
      </React.Fragment>
    ));
  }

  return (
    <div className="cg-content" data-testid="gallery-chart-recipes">
      {content}
    </div>
  );
}
