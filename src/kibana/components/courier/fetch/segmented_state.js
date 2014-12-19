define(function (require) {
  return function CourierSegmentedStateProvider(es, Private, Promise, Notifier, timefilter) {
    var _ = require('lodash');
    var Events = Private(require('factories/events'));

    var notify = new Notifier({
      location: 'Segmented Fetch'
    });

    _(SegmentedState).inherits(Events);
    function SegmentedState(source, init) {
      SegmentedState.Super.call(this);

      this.source = source;
      this.totalSize = false;
      this.direction = 'desc';

      if (_.isFunction(init)) {
        init(this);
      }

      this.remainingSize = this.totalSize !== false ? this.totalSize : false;

      this.all = this.getIndexList(this.source, this.direction);
      this.queue = this.all.slice(0);
      this.complete = [];

      this.mergedResponse = {
        took: 0,
        hits: {
          hits: [],
          total: 0,
          max_score: 0
        }
      };

      this.emitChain = this.emit('status', this._statusReport(null));

      this.getFlattenedSource = _.once(function () {
        return this.source._flatten();
      });
    }

    SegmentedState.prototype._statusReport = function (active) {
      return {
        total: this.all.length,
        complete: this.complete.length,
        remaining: this.queue.length,
        active: active
      };
    };

    SegmentedState.prototype.getSourceStateFromRequest = function (req) {
      var self = this;
      var emits = [];

      return self.getFlattenedSource().then(function (flatSource) {
        var first = self.queue.length === self.all.length;
        var index = self.queue.shift();
        var last = self.queue.length === 0;

        // update the status on every iteration
        self.emitChain = self.emitChain.then(function () {
          emits.push(['status', self._statusReport(index)]);
        });

        var requestersDefer = req.defer;
        var ourDefer = req.defer = Promise.defer();

        ourDefer.promise
        .then(function (resp) {
          if (resp) self._consumeSegment(resp);

          req.resp = _.omit(self.mergedResponse, '_bucketIndex');
          self.complete.push(index);

          if (resp) {
            if (first) emits.push(['first', resp]);
            emits.push(['segment', resp]);
            emits.push(['mergedSegment', req.resp]);
          }

          self.emitChain = self.emitChain
          .then(function nextEmit() {
            var emit = emits.shift();
            if (emit) {
              return self.emit(emit[0], emit[1]).then(nextEmit);
            }
          });

          if (last) {
            emits.push(['complete']);
            self.emitChain = self.emitChain.then(function () {
              requestersDefer.resolve(req.resp);
            });
          }
        });

        var state = _.cloneDeep(flatSource);
        state.index = index;
        if (self.remainingSize !== false) {
          state.body.size = self.remainingSize;
        }

        return state;
      });
    };


    SegmentedState.prototype._consumeSegment = function (resp) {
      if (this.remainingSize !== false) {
        this.remainingSize -= resp.hits.hits.length;
      }

      this._mergeResponse(this.mergedResponse, resp);
    };


    SegmentedState.prototype.getIndexList = function () {
      var self = this;
      var timeBounds = timefilter.getBounds();
      var list = self.source.get('index').toIndexList(timeBounds.min, timeBounds.max);

      if (!_.isArray(list)) list = [list];
      if (self.direction === 'desc') list = list.reverse();

      return list;
    };


    SegmentedState.prototype._mergeResponse = notify.timed('merge response segment', function (merged, resp) {
      merged.took += resp.took;
      merged.hits.total = Math.max(merged.hits.total, resp.hits.total);
      merged.hits.max_score = Math.max(merged.hits.max_score, resp.hits.max_score);
      [].push.apply(merged.hits.hits, resp.hits.hits);

      if (!resp.aggregations) return;

      Object.keys(resp.aggregations).forEach(function (aggKey) {

        if (!merged.aggregations) {
          // start merging aggregations
          merged.aggregations = {};
          merged._bucketIndex = {};
        }

        if (!merged.aggregations[aggKey]) {
          merged.aggregations[aggKey] = {
            buckets: []
          };
        }

        resp.aggregations[aggKey].buckets.forEach(function (bucket) {
          var mbucket = merged._bucketIndex[bucket.key];
          if (mbucket) {
            mbucket.doc_count += bucket.doc_count;
            return;
          }

          mbucket = merged._bucketIndex[bucket.key] = bucket;
          merged.aggregations[aggKey].buckets.push(mbucket);
        });
      });
    });

    return SegmentedState;
  };
});