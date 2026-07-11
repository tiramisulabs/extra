import { AutoLoad, Command, Declare } from 'seyfert';

@Declare({ name: 'circ', description: 'Circular graph parent' })
@AutoLoad()
export default class CircParent extends Command {}
