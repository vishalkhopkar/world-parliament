import { useEffect } from 'react';
import { useStore } from '../state/store';
import './Toast.css';

export function Toast() {
  const error = useStore(s => s.error);
  const setError = useStore(s => s.setError);
  useEffect(() => {
    if (!error) return;
    const h = setTimeout(() => setError(null), 4500);
    return () => clearTimeout(h);
  }, [error, setError]);
  if (!error) return null;
  return <div className="toast" role="alert" onClick={() => setError(null)}>{error}</div>;
}
