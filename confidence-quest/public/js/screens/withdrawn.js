import { heading, mount, paragraphs } from '../dom.js';

export function renderWithdrawn(ctx, state) {
  mount(ctx.root, heading(state.withdrawn.title), ...paragraphs(state.withdrawn.paragraphs));
}
