import './app.css';
import 'highlight.js/styles/github-dark.css';
import App from './App.svelte';
import { mount } from 'svelte';

const app = mount(App, { target: document.body });

export default app;
