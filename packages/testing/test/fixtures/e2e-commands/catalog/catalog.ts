import { AutoLoad, Command, Declare } from 'seyfert';

@Declare({ name: 'catalog', description: 'Catalog parent' })
@AutoLoad()
export default class CatalogParent extends Command {}
