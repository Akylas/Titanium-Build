'use babel';

import {
    SelectListView
} from 'atom-space-pen-views';

export default class TargetsView extends SelectListView {

    constructor() {
        super(...arguments);
        // this.show();
    }

    initialize() {
        super.initialize(...arguments);
        this.list.addClass('mark-active');
    }

    show() {
        if (!this.panel) {
            this.panel = atom.workspace.addModalPanel({
                item: this
            });
        }
        this.panel.show();
        this.focusFilterEditor();
        return this;
    }

    hide() {
        if (this.panel) {
            this.panel.hide();
        }
        return this;
    }

    setItems() {
        super.setItems(...arguments);

        const activeItemView = this.find('.active');
        if (0 < activeItemView.length) {
            this.selectItemView(activeItemView);
            this.scrollToItemView(activeItemView);
        }
        return this;
    }

    setLoading() {
        super.setLoading(...arguments);
        return this;
    }

    setActiveTarget(target) {
        this.activeTarget = target;
        return this;
    }

    viewForItem(item) {
        const activeTarget = this.activeTarget;
        if (item.title) {
            var title = item.title;
            const activeClass = (title === activeTarget ? 'active' : '');
            // this.li({ class: activeClass + ' build-target' }, title);
            if (item.subtitle) {
                return '<li class="' + activeClass + ' two-lines build-target' + '">' +
                    '<div class="primary-line">' + item.title + '</div>' +
                    '<div class="secondary-line">' + item.subtitle + '</div>' +
                    '</li>';
            } else {
                return '<li class="' + activeClass + ' build-target' + '">' + item.title + '</li>';
            }
        } else {
            const activeClass = (item === activeTarget ? 'active' : '');
            // this.li({ class: activeClass + ' build-target' }, item);
            return '<li class="' + activeClass + ' build-target' + '">' + item + '</li>';
        }
    }

    getEmptyMessage(itemCount) {
        return (itemCount === 0) ? 'No targets found.' : 'No matches';
    }

    awaitSelection() {
        if (!this.panel || !this.panel.isVisible()) {
            this.show();
        }
        return new Promise((resolve, reject) => {
            this.resolveFunction = resolve;
        });
    }

    confirmed(target) {
        if (this.resolveFunction) {
            this.resolveFunction(target);
            this.resolveFunction = null;
        }
        // this.hide();
    }

    cancelled() {
        this.hide();
    }
}
