import './app.css';
import 'highlight.js/styles/github-dark.css';
import App from './App.svelte';
import { mount } from 'svelte';

const app = mount(App, { target: document.body });
document.body.classList.add('svelte-mounted');

export default app;
