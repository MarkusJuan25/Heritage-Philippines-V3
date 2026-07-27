// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { Pagination } from './Pagination';

describe('Pagination', () => {
  it('renders nothing when total is 0', () => {
    const { container } = render(
      <Pagination page={1} pageSize={20} total={0} buildHref={() => '/admin/leads'} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('disables Previous (no link) on the first page, and links Next', () => {
    render(
      <Pagination page={1} pageSize={20} total={45} buildHref={(p) => `/admin/leads?page=${p}`} />,
    );

    expect(screen.getByText('Previous')).not.toHaveAttribute('href');
    const next = screen.getByRole('link', { name: 'Next' });
    expect(next).toHaveAttribute('href', '/admin/leads?page=2');
    expect(screen.getByText('Page 1 of 3 (45 total)')).toBeInTheDocument();
  });

  it('links both Previous and Next on a middle page', () => {
    render(
      <Pagination page={2} pageSize={20} total={45} buildHref={(p) => `/admin/leads?page=${p}`} />,
    );

    expect(screen.getByRole('link', { name: 'Previous' })).toHaveAttribute(
      'href',
      '/admin/leads?page=1',
    );
    expect(screen.getByRole('link', { name: 'Next' })).toHaveAttribute(
      'href',
      '/admin/leads?page=3',
    );
  });

  it('disables Next (no link) on the last page', () => {
    render(
      <Pagination page={3} pageSize={20} total={45} buildHref={(p) => `/admin/leads?page=${p}`} />,
    );

    expect(screen.getByRole('link', { name: 'Previous' })).toBeInTheDocument();
    expect(screen.getByText('Next')).not.toHaveAttribute('href');
  });

  it('calls buildHref with the correct target page numbers', () => {
    const buildHref = vi.fn((p: number) => `/admin/leads?page=${p}`);
    render(<Pagination page={2} pageSize={10} total={30} buildHref={buildHref} />);

    expect(buildHref).toHaveBeenCalledWith(1);
    expect(buildHref).toHaveBeenCalledWith(3);
  });

  it('has an accessible navigation landmark', () => {
    render(
      <Pagination page={1} pageSize={20} total={45} buildHref={(p) => `/admin/leads?page=${p}`} />,
    );
    expect(screen.getByRole('navigation', { name: 'Pagination' })).toBeInTheDocument();
  });
});
