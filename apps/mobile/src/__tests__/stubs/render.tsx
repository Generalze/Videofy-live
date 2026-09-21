/** @author masterzee001 */
/**
 * RENDERING, FOR TESTS THAT NEED TO SEE A PROP.
 *
 * Everything here is reading, not deciding. The helpers walk the tree
 * `react-test-renderer` produces against the react-native stub next door and
 * answer the four questions a mutant changes the answer to: which components
 * were drawn, with which props, with which styles, and what words a person
 * would read. Nothing in this file knows anything about calls.
 */
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { ReactElement } from 'react';

/*
 * React needs telling that this environment can run `act`. Without it every
 * render logs "The current testing environment is not configured to support
 * act(...)" and state updates escape the batch.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface TreeNode {
  readonly type: string;
  readonly props: Record<string, unknown>;
  readonly children: readonly (TreeNode | string)[] | null;
}

export function isNode(value: TreeNode | string | null | undefined): value is TreeNode {
  return typeof value === 'object' && value !== null;
}

/** Render, inside act, and hand back both the renderer and the tree. */
export function render(element: ReactElement): {
  readonly renderer: ReactTestRenderer;
  readonly tree: TreeNode;
} {
  let renderer: ReactTestRenderer | null = null;
  act(() => {
    renderer = create(element);
  });
  const made = renderer as ReactTestRenderer | null;
  if (made === null) throw new Error('render produced nothing');
  return { renderer: made, tree: treeOf(made) };
}

export function treeOf(renderer: ReactTestRenderer): TreeNode {
  const json = renderer.toJSON();
  if (json === null || Array.isArray(json)) {
    // An array is a fragment at the root; wrap it so callers have one node.
    return {
      type: 'root',
      props: {},
      children: (json ?? []) as unknown as readonly (TreeNode | string)[],
    };
  }
  return json as unknown as TreeNode;
}

/** Every node of a type, in document order. */
export function nodesOfType(root: TreeNode, type: string): TreeNode[] {
  const found: TreeNode[] = [];
  walk(root, (node) => {
    if (node.type === type) found.push(node);
  });
  return found;
}

/** Every node matching a predicate, in document order. */
export function nodesWhere(root: TreeNode, match: (node: TreeNode) => boolean): TreeNode[] {
  const found: TreeNode[] = [];
  walk(root, (node) => {
    if (match(node)) found.push(node);
  });
  return found;
}

export function walk(node: TreeNode, visit: (node: TreeNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) {
    if (isNode(child)) walk(child, visit);
  }
}

/** Every string a person would read, in order. */
export function textsOf(node: TreeNode | string): string[] {
  const out: string[] = [];
  const collect = (value: TreeNode | string): void => {
    if (typeof value === 'string') {
      out.push(value);
      return;
    }
    for (const child of value.children ?? []) collect(child);
  };
  collect(node);
  return out;
}

/** The text of one node, joined -- RN splits interpolation into several children. */
export function textOf(node: TreeNode): string {
  return textsOf(node).join('');
}

/** A node's style, flattened the way the platform would flatten it. */
export function styleOf(node: TreeNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const add = (value: unknown): void => {
    if (value === null || value === undefined || value === false) return;
    if (Array.isArray(value)) {
      for (const entry of value) add(entry);
      return;
    }
    if (typeof value === 'object') Object.assign(out, value as Record<string, unknown>);
  };
  add(node.props['style']);
  return out;
}

/** True when any node in the tree carries this exact text. */
export function hasText(root: TreeNode, text: string): boolean {
  return textsOf(root).some((value) => value === text);
}

/** The one node whose accessibility label is this, or null. */
export function byLabel(root: TreeNode, label: string): TreeNode | null {
  return nodesWhere(root, (node) => node.props['accessibilityLabel'] === label)[0] ?? null;
}
