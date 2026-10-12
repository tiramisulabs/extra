import { useRef, useState } from 'react';
import { errorText } from './format';

/** One control owns its request until it settles, including reentrant events before React renders. */
export function usePendingAction() {
	const sending = useRef(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState('');
	async function run(action: () => void | Promise<void>) {
		if (sending.current) return;
		sending.current = true;
		setPending(true);
		setError('');
		try {
			await action();
		} catch (reason) {
			setError(errorText(reason));
		} finally {
			sending.current = false;
			setPending(false);
		}
	}
	return { pending, error, run };
}
