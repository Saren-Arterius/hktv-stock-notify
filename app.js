var config = require('./config.json');
var winston = require('winston');
var nodemailer = require('nodemailer');
var rp = require('request-promise');
var cheerio = require('cheerio');
var Async = require('async');
var Sequelize = require('sequelize');

String.prototype.format = function () {
  var args = arguments;
  return this.replace(/{(\d+)}/g, function (match, number) {
    return typeof args[number] !== 'undefined' ? args[number] : match;
  });
};

var Log = new winston.Logger({
  transports: [
    new winston.transports.Console({
      timestamp: function () {
        return new Date();
      },
      formatter: function (options) {
        return '[{0}] [{1}] {2}'.format(options.timestamp().toISOString(),
          options.level.toUpperCase(), options.message);
      }
    })
  ]
});

var transporter = nodemailer.createTransport(config.smtp_url);

var sequelize = new Sequelize('database', 'username', 'password', {
  host: 'localhost',
  dialect: 'sqlite',
  storage: config.sqlite_filename,
  logging: Log.debug
});

var StockItem = sequelize.define('StockItem', {
  itemName: Sequelize.STRING,
  productUrl: Sequelize.STRING
});

var InStockRecord = sequelize.define('InItemRecord', {
  inStock: Sequelize.BOOLEAN
});

StockItem.hasMany(InStockRecord);
InStockRecord.belongsTo(StockItem);

var makeRequestOptions = function (stockItem) {
  return {
    uri: stockItem.productUrl,
    transform: function (body) {
      return cheerio.load(body);
    }
  };
};

var sendEmail = function (result) {
  var mailOptions = {
    from: 'HKTVmall stock notify system <{0}>'.format(config.from_email),
    to: config.to_email,
    subject: result.name + ' is now in stock',
    text: 'Link to product url:\n{0}\n\nDate: {1}'.format(result.url, result.date),
    html: 'Link to product url:</br><a href="{0}">{0}</a></br></br>Date: {1}'.format(result.url, result.date)
  };
  transporter.sendMail(mailOptions, function (error, info) {
    if (error) {
      return Log.error(error);
    }
    Log.info('Message sent: ' + info.response);
  });
};

var extractStockInfoFromItem = function (stockItem, callback) {
  Log.debug('Requesting ({0}): '.format(stockItem.id) + stockItem.productUrl);
  rp(makeRequestOptions(stockItem)).then(function ($) {
    Log.debug('Got page body: ' + stockItem.id);
    var inStock = $('.disabled.large').length === 0;
    callback(null, {
      id: stockItem.id,
      name: stockItem.itemName,
      url: stockItem.productUrl,
      inStock: inStock,
      date: new Date()
    });
  }).catch(function (err) {
    callback(err);
  });
};

var upsertStockInfo = function (result, callback) {
  InStockRecord.findOne({
    where: {
      StockItemId: result.id
    },
    order: [
      ['id', 'DESC']
    ]
  }).then(function (lastRecord) {
    if (!lastRecord || lastRecord.inStock !== result.inStock) {
      return InStockRecord.create({
        StockItemId: result.id,
        inStock: result.inStock
      });
    }
    callback(null, true);
  }).then(function (createdRecord) {
    if (!createdRecord) return;
    if (result.inStock) {
      sendEmail(result);
    }
    callback(null, true);
  }).catch(callback);
};

var pauseIfDone = function (err, done) {
  if (err) Log.error(err);
  Log.debug('Done! Will call main again {0} minutes later'.format(config.run_interval_minutes));
  setTimeout(main, config.run_interval_minutes * 60 * 1000);
};

var main = function () {
  Log.debug('Called main');
  StockItem.findAll().then(function (stockItems) {
    Async.map(stockItems, extractStockInfoFromItem, function (err, results) {
      if (err) Log.error(err);
      Async.map(results, upsertStockInfo, pauseIfDone);
    });
  });
};

sequelize.sync().then(function () {
  Log.info('Sequalize sync finished');
  main();
  Log.info('Started HKTVmall stock notify system');
});
