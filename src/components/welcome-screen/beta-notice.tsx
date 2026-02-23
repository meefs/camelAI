interface BetaNoticeProps {
  onFeedbackClick: () => void;
}

export function BetaNotice({ onFeedbackClick }: BetaNoticeProps) {
  return (
    <p className="text-center text-xs text-muted-foreground">
      You&apos;re in the early access beta. Things may break &mdash;{" "}
      <button
        type="button"
        onClick={onFeedbackClick}
        className="underline underline-offset-2 font-medium hover:text-foreground transition-colors"
      >
        share feedback
      </button>
    </p>
  );
}
