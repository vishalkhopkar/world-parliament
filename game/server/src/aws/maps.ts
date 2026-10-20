// Every maps/<id>/ game package is bundled into the Lambda (esbuild inlines the JSON via the generated registry,
// see server/src/maps.generated.ts); kernels are built lazily and cached per container.
import { makeRegistryMapProvider } from '../core/maps';

export const awsMaps = makeRegistryMapProvider();
