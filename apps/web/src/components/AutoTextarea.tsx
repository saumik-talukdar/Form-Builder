import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";

/** A textarea that grows with its text, so long titles wrap instead of being cut off. */
export function AutoTextarea(
  props: TextareaHTMLAttributes<HTMLTextAreaElement>,
) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    };
    fit();
    // Web fonts load after first paint and change how the text wraps.
    let live = true;
    void document.fonts?.ready.then(() => live && fit());
    // Wrapping also changes when the container is resized (rotating a phone, for example).
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => {
      live = false;
      ro.disconnect();
    };
  }, [props.value]);

  return <textarea ref={ref} rows={1} {...props} />;
}
