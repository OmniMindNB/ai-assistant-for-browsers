import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

describe('sidepanel component test harness', () => {
  it('renders accessible React content', () => {
    render(<button type="button">New chat</button>);
    expect(screen.getByRole('button', { name: 'New chat' })).toBeInTheDocument();
  });
});
