/** @format */
/**
 * Ant Design `message` with tap/click-to-dismiss on each toast.
 */
import { message as antdMessage } from "antd";
import type { ArgsProps, JointContent } from "antd/es/message/interface";
import type { ReactNode } from "react";

let keySeq = 0;

function nextKey(): string {
  keySeq += 1;
  return `bella-msg-${keySeq}-${Date.now()}`;
}

function attachClickToDismiss(args: ArgsProps): ArgsProps {
  const k = args.key ?? nextKey();
  const prevOnClick = args.onClick;
  return {
    ...args,
    key: k,
    style: { cursor: "pointer", ...args.style },
    onClick: (e) => {
      prevOnClick?.(e);
      antdMessage.destroy(k);
    },
  };
}

function wrapType(type: NonNullable<ArgsProps["type"]>) {
  return (
    jointContent: JointContent,
    duration?: number | VoidFunction,
    onClose?: VoidFunction,
  ) => {
    let config: ArgsProps;
    if (
      jointContent &&
      typeof jointContent === "object" &&
      "content" in jointContent
    ) {
      config = { ...(jointContent as ArgsProps) };
    } else {
      config = { content: jointContent as ReactNode };
    }
    if (typeof duration === "function") {
      config.onClose = duration;
    } else {
      config.duration = duration;
      config.onClose = onClose;
    }
    config.type = type;
    return antdMessage.open(attachClickToDismiss(config));
  };
}

export const message = {
  ...antdMessage,
  open: (config: ArgsProps) => antdMessage.open(attachClickToDismiss(config)),
  success: wrapType("success"),
  error: wrapType("error"),
  warning: wrapType("warning"),
  info: wrapType("info"),
  loading: wrapType("loading"),
};
