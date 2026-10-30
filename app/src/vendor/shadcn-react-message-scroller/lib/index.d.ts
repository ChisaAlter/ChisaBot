import * as react_jsx_runtime from 'react/jsx-runtime';
import * as React from 'react';
import { U as UseRenderComponentProps } from './render.js';

type MessageScrollerDefaultScrollPosition = "start" | "end" | "last-anchor";
type MessageScrollerButtonDirection = "start" | "end";
type MessageScrollerScrollAlign = "start" | "center" | "end" | "nearest";
type MessageScrollerScrollOptions = {
    align?: MessageScrollerScrollAlign;
    behavior?: ScrollBehavior;
    scrollMargin?: number;
};
type MessageScrollerScrollable = {
    start: boolean;
    end: boolean;
};
type MessageScrollerVisibilityState = {
    currentAnchorId: string | null;
    visibleMessageIds: string[];
};
type MessageScrollerProviderProps = {
    children?: React.ReactNode;
    autoScroll?: boolean;
    defaultScrollPosition?: MessageScrollerDefaultScrollPosition;
    scrollEdgeThreshold?: number;
    scrollPreviousItemPeek?: number;
    scrollMargin?: number;
};
type MessageScrollerProps = React.ComponentProps<"div">;
type MessageScrollerViewportProps = React.ComponentProps<"div"> & {
    preserveScrollOnPrepend?: boolean;
};
type MessageScrollerContentProps = React.ComponentProps<"div"> & {
    spacerClassName?: string;
};
type MessageScrollerItemProps = React.ComponentProps<"div"> & {
    messageId?: string;
    scrollAnchor?: boolean;
};
type MessageScrollerButtonRenderState = {
    active: boolean;
    direction: MessageScrollerButtonDirection;
};
type MessageScrollerButtonProps = UseRenderComponentProps<"button", MessageScrollerButtonRenderState> & {
    behavior?: ScrollBehavior;
    direction?: MessageScrollerButtonDirection;
};

declare function useMessageScroller(): {
    scrollToEnd: (options?: MessageScrollerScrollOptions) => boolean;
    scrollToMessage: (messageId: string, options?: MessageScrollerScrollOptions) => boolean;
    scrollToStart: (options?: MessageScrollerScrollOptions) => boolean;
};
declare function useMessageScrollerScrollable(): MessageScrollerScrollable;
declare function useMessageScrollerVisibility(): MessageScrollerVisibilityState;
declare function MessageScrollerProvider({ autoScroll, children, defaultScrollPosition, scrollEdgeThreshold, scrollPreviousItemPeek, scrollMargin, }: MessageScrollerProviderProps): react_jsx_runtime.JSX.Element;
declare function MessageScroller$1({ children, ...props }: MessageScrollerProps): react_jsx_runtime.JSX.Element;
declare function MessageScrollerViewport({ "aria-label": ariaLabel, children, onKeyDown, onScroll, onTouchMove, onWheel, preserveScrollOnPrepend, ref, role, tabIndex, ...props }: MessageScrollerViewportProps): react_jsx_runtime.JSX.Element;
declare function MessageScrollerContent({ "aria-relevant": ariaRelevant, children, ref, role, spacerClassName, ...props }: MessageScrollerContentProps): react_jsx_runtime.JSX.Element;
declare function MessageScrollerItem({ messageId, ref, scrollAnchor, ...props }: MessageScrollerItemProps): react_jsx_runtime.JSX.Element;
declare function MessageScrollerButton({ behavior, children, direction, onClick, render, tabIndex, type, ...props }: MessageScrollerButtonProps): React.ReactElement<any, string | React.JSXElementConstructor<any>> | null;

declare const MessageScroller: {
    Provider: typeof MessageScrollerProvider;
    Root: typeof MessageScroller$1;
    Viewport: typeof MessageScrollerViewport;
    Content: typeof MessageScrollerContent;
    Item: typeof MessageScrollerItem;
    Button: typeof MessageScrollerButton;
};

export { MessageScroller, type MessageScrollerDefaultScrollPosition, type MessageScrollerScrollAlign, type MessageScrollerScrollOptions, type MessageScrollerScrollable, type MessageScrollerVisibilityState, useMessageScroller, useMessageScrollerScrollable, useMessageScrollerVisibility };
