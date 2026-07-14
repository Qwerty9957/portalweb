

;(() => {
	if(typeof window === 'undefined') return;

	window.addEventListener('beforeunload', function (event) {
		event.preventDefault()
	})

	window.addEventListener('unhandledrejection', function (event) {
		console.error('UNHANDLED REJECTION:', event.reason?.message || event.reason);
	})

	canvasElement.onkeypress = e => e.preventDefault()

	addRunDependency('load_game_data')
})();
