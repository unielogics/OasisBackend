// HTTP schemas use Zod 4 (the type provider and OpenAPI generation need it). The rest of the codebase still imports
// zod v3 from 'zod' (env contract, ports); import { z } from this module for anything attached to a route.
export { z } from 'zod/v4'
