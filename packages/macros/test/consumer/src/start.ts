import { Search } from './command.js';

const command = new Search();
if (command.name !== 'search') throw new Error('Command decorators were lost');
if (!command.options) throw new Error('Command options were lost');
console.log(`Ready: ${command.name}; options=${command.options.map(option => option.name).join(',')}`);
