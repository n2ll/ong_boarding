import * as React from "react";

import { agentStagePresentation, applicantStatusPresentation } from "@/lib/admin/stage-presentation";
import { Badge } from "./badge";

type StageBadgeProps = Omit<React.ComponentProps<typeof Badge>, "children" | "variant"> & {
  stage: string;
  label?: string;
  count?: number;
};

const StageBadge = React.forwardRef<HTMLSpanElement, StageBadgeProps>(function StageBadge(
  { stage, label, count, ...props },
  ref,
) {
  const presentation = agentStagePresentation(stage);
  const text = label ?? presentation.label;

  return (
    <Badge ref={ref} variant={presentation.variant} {...props}>
      {text}{count === undefined ? "" : ` ${count}`}
    </Badge>
  );
});

export { StageBadge };

type ApplicantStatusBadgeProps = Omit<React.ComponentProps<typeof Badge>, "children" | "variant"> & {
  status: string;
};

const ApplicantStatusBadge = React.forwardRef<HTMLSpanElement, ApplicantStatusBadgeProps>(function ApplicantStatusBadge(
  { status, ...props },
  ref,
) {
  const presentation = applicantStatusPresentation(status);

  return (
    <Badge ref={ref} variant={presentation.variant} {...props}>
      {presentation.label}
    </Badge>
  );
});

export { ApplicantStatusBadge };
