// Shared by the fielding tests: the map's numbers come from the config, never from the test.
import { WORLD_CONFIG } from '@hp/shared';
import { formatMoney } from '../../lib';

export { WORLD_CONFIG };
export const formatMoneyForTest = (n: number) => formatMoney(n, WORLD_CONFIG.currency.symbol);
