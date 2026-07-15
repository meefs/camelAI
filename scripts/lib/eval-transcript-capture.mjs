export function createEvalTranscriptCapture(startMarker, endMarker) {
  let captured = "";
  let tail = "";
  let capturing = false;
  let complete = false;

  return {
    observe(chunk) {
      if (complete) return;

      let text = tail + chunk.toString("utf8");
      tail = "";
      while (text.length > 0 && !complete) {
        if (!capturing) {
          const startIndex = text.indexOf(startMarker);
          if (startIndex === -1) {
            tail = text.slice(-startMarker.length);
            return;
          }
          capturing = true;
          text = text.slice(startIndex + startMarker.length);
        }

        const endIndex = text.indexOf(endMarker);
        if (endIndex === -1) {
          const keep = Math.max(endMarker.length - 1, 0);
          if (text.length > keep) {
            captured += text.slice(0, -keep);
            tail = text.slice(-keep);
          } else {
            tail = text;
          }
          return;
        }

        captured += text.slice(0, endIndex);
        complete = true;
      }
    },
    get captured() {
      return captured;
    },
    get complete() {
      return complete;
    },
  };
}
