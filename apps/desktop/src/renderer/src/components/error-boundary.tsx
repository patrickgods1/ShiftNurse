/**
 * The last line under the router's own per-page error component. A render error in the shell
 * itself — the setup gate, the unit provider, the nav — would otherwise unmount React and leave
 * a blank window with no way back but quitting. This says what happened and offers a reload;
 * the data is in the database, not the page, so a reload loses nothing saved.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { PRIMARY } from './ui.js';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | undefined;
}

export class AppErrorBoundary extends Component<Props, State> {
  override state: State = { error: undefined };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[renderer] the app shell failed to render:', error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (error === undefined) return this.props.children;
    return (
      <div
        role="alert"
        className="flex h-screen flex-col items-center justify-center gap-3 bg-bg p-8 text-center text-text"
      >
        <p className="font-medium text-danger">ShiftNurse hit a problem showing this screen.</p>
        <p className="max-w-lg text-sm text-text-muted">{error.message}</p>
        <p className="max-w-lg text-sm text-text-muted">
          Everything you saved is safe. Reloading usually clears this.
        </p>
        <button type="button" className={PRIMARY} onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
