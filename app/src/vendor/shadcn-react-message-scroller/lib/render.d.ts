import * as React from 'react';

type RenderState = Record<string, unknown>;
type RenderFunction<TState extends RenderState> = (props: Record<string, unknown>, state: TState) => React.ReactElement | null;
type RenderProp<TState extends RenderState> = React.ReactElement | RenderFunction<TState>;
type UseRenderComponentProps<TElement extends React.ElementType, TState extends RenderState = RenderState> = React.ComponentPropsWithRef<TElement> & {
    render?: RenderProp<TState>;
};

export type { UseRenderComponentProps as U };
