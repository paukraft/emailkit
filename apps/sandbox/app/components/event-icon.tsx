import {
  RiMailLine,
  RiMailSendLine,
  RiMailCheckLine,
  RiMailOpenLine,
  RiLinkM,
  RiErrorWarningLine,
  RiSpamLine,
  RiCloseCircleLine,
  RiSendPlaneFill,
  RiQuestionLine,
} from "@remixicon/react";

const ICON_MAP: Record<string, typeof RiMailLine> = {
  mail: RiMailLine,
  "mail-send": RiMailSendLine,
  "mail-check": RiMailCheckLine,
  "mail-open": RiMailOpenLine,
  link: RiLinkM,
  "error-warning": RiErrorWarningLine,
  spam: RiSpamLine,
  "close-circle": RiCloseCircleLine,
  "send-plane": RiSendPlaneFill,
  question: RiQuestionLine,
};

export function EventIcon({ iconKey, className }: { iconKey: string; className?: string }) {
  const Icon = ICON_MAP[iconKey] ?? RiQuestionLine;
  return <Icon className={className ?? "size-3.5"} />;
}
